const COZE_BASE_URL = (process.env.COZE_API_BASE ?? "https://api.coze.cn").replace(/\/+$/, "");
const COZE_API_TOKEN = process.env.COZE_API_TOKEN ?? "";
const COZE_INTERPRET_BOT_ID = process.env.COZE_INTERPRET_BOT_ID ?? "";

type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };
type ReportStrategy = "professional_premium" | "needs_resonance" | "solution_test";

function safeJsonParse(text: string): JsonValue | null {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return null;
  }
}

async function readResponseBody(res: Response) {
  const contentType = res.headers.get("content-type") ?? "";
  const text = await res.text();
  const textTrimmed = text.trim();
  const maybeJson =
    contentType.includes("application/json") ||
    textTrimmed.startsWith("{") ||
    textTrimmed.startsWith("[");
  const json = maybeJson ? safeJsonParse(text) : null;
  return { text, json };
}

function findFirstString(obj: unknown, keyCandidates: string[]): string | null {
  const visited = new Set<unknown>();

  function walk(node: unknown): string | null {
    if (node == null) return null;
    if (typeof node === "string") return null;
    if (typeof node !== "object") return null;
    if (visited.has(node)) return null;
    visited.add(node);

    if (Array.isArray(node)) {
      for (const item of node) {
        const r = walk(item);
        if (r) return r;
      }
      return null;
    }

    const rec = node as Record<string, unknown>;
    for (const k of keyCandidates) {
      const v = rec[k];
      if (typeof v === "string" && v.trim().length > 0) return v.trim();
    }
    for (const v of Object.values(rec)) {
      const r = walk(v);
      if (r) return r;
    }
    return null;
  }

  return walk(obj);
}

function extractChatIds(payload: unknown) {
  const conversationId = findFirstString(payload, ["conversation_id", "conversationId"]);
  const chatId = findFirstString(payload, ["chat_id", "chatId", "id"]);
  return { conversationId, chatId };
}

function extractChatStatus(payload: unknown) {
  const status = findFirstString(payload, ["status"]);
  return status?.toUpperCase() ?? null;
}

function extractErrorMessage(payload: unknown) {
  return findFirstString(payload, ["msg", "message", "error_message", "errorMessage", "detail"]);
}

function pickAnswerContent(payload: unknown) {
  if (!payload || typeof payload !== "object") return null;
  const rec = payload as Record<string, unknown>;
  const list = rec["data"];
  if (!Array.isArray(list)) return null;
  const rows = list.filter((x) => x && typeof x === "object") as Record<string, unknown>[];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    const type = typeof row["type"] === "string" ? row["type"] : "";
    const content = typeof row["content"] === "string" ? row["content"].trim() : "";
    if (type === "answer" && content.length > 0) return content;
  }
  return null;
}

function normalizeStrategy(value: unknown): ReportStrategy {
  if (value === "professional_premium" || value === "needs_resonance" || value === "solution_test") return value;
  return "professional_premium";
}

async function cozeFetch(url: string, init: RequestInit) {
  if (!COZE_API_TOKEN) {
    throw new Error("COZE_API_TOKEN missing");
  }
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${COZE_API_TOKEN}`);
  headers.set("Accept", "application/json");
  return fetch(url, { ...init, headers });
}

async function createInterpretChat(clientDataJsonString: string) {
  if (!COZE_INTERPRET_BOT_ID) {
    throw new Error("COZE_INTERPRET_BOT_ID missing");
  }
  const userId = "ipis_web";
  const body: Record<string, unknown> = {
    bot_id: COZE_INTERPRET_BOT_ID,
    user_id: userId,
    stream: false,
    additional_messages: [
      {
        role: "user",
        content: clientDataJsonString,
        content_type: "text",
      },
    ],
  };

  const res = await cozeFetch(`${COZE_BASE_URL}/v3/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const { json, text } = await readResponseBody(res);
  if (!res.ok) {
    return { ok: false as const, status: res.status, body: json ?? text };
  }
  const payload = json ?? text;
  const { conversationId, chatId } = extractChatIds(payload);
  if (!conversationId || !chatId) {
    return { ok: false as const, status: 502, body: { msg: "Chat created but ids missing", raw: payload } };
  }
  return { ok: true as const, conversationId, chatId };
}

async function retrieveChatOnce(conversationId: string, chatId: string) {
  const retrieveUrl = new URL(`${COZE_BASE_URL}/v3/chat/retrieve`);
  retrieveUrl.searchParams.set("conversation_id", conversationId);
  retrieveUrl.searchParams.set("chat_id", chatId);
  const retrieveRes = await cozeFetch(retrieveUrl.toString(), { method: "GET" });
  const retrieveBody = await readResponseBody(retrieveRes);
  if (!retrieveRes.ok) {
    return { ok: false as const, status: retrieveRes.status, body: retrieveBody.json ?? retrieveBody.text };
  }
  const retrievePayload = retrieveBody.json ?? retrieveBody.text;
  const status = extractChatStatus(retrievePayload);
  if (status === "COMPLETED" || status === "DONE" || status === "SUCCESS") {
    await new Promise((resolve) => setTimeout(resolve, 800));
  }

  const listUrl = new URL(`${COZE_BASE_URL}/v3/chat/message/list`);
  listUrl.searchParams.set("chat_id", chatId);
  listUrl.searchParams.set("conversation_id", conversationId);
  const listRes = await cozeFetch(listUrl.toString(), {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });
  const listBody = await readResponseBody(listRes);
  if (!listRes.ok) {
    return { ok: false as const, status: listRes.status, body: listBody.json ?? listBody.text };
  }

  const messageListPayload = listBody.json ?? listBody.text;
  const answer = pickAnswerContent(messageListPayload);
  const errorMessage = extractErrorMessage(messageListPayload) ?? extractErrorMessage(retrievePayload);
  return {
    ok: true as const,
    payload: retrievePayload,
    status,
    answer,
    errorMessage,
  };
}

export async function POST(req: Request) {
  if (!COZE_API_TOKEN || !COZE_INTERPRET_BOT_ID) {
    return Response.json({ error: "Missing COZE_API_TOKEN or COZE_INTERPRET_BOT_ID" }, { status: 500 });
  }

  try {
    const rawBody = (await req.json()) as unknown;
    const rec = rawBody && typeof rawBody === "object" ? (rawBody as Record<string, unknown>) : null;
    if (!rec) {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const strategy = normalizeStrategy(rec.strategy);
    const clientDataJson = rec.client_data_json ?? null;
    const clientDataJsonString = JSON.stringify(clientDataJson ?? null);

    const chat = await createInterpretChat(clientDataJsonString);
    if (!chat.ok) {
      return Response.json({ step: "chat_create", error: chat.body }, { status: chat.status });
    }

    return Response.json(
      {
        botId: COZE_INTERPRET_BOT_ID,
        conversationId: chat.conversationId,
        chatId: chat.chatId,
        strategy,
      },
      { status: 202, headers: { "X-Coze-Bot-Id": COZE_INTERPRET_BOT_ID } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "bad_request";
    return Response.json({ error: message }, { status: 400 });
  }
}

export async function GET(req: Request) {
  if (!COZE_API_TOKEN) {
    return Response.json({ error: "Missing COZE_API_TOKEN" }, { status: 500 });
  }

  const url = new URL(req.url);
  const conversationId =
    url.searchParams.get("conversation_id") ?? url.searchParams.get("conversationId") ?? "";
  const chatId = url.searchParams.get("chat_id") ?? url.searchParams.get("chatId") ?? "";
  if (!conversationId || !chatId) {
    return Response.json({ error: "Missing conversation_id/chat_id" }, { status: 400 });
  }

  const result = await retrieveChatOnce(conversationId, chatId);
  if (!result.ok) {
    return Response.json({ step: "chat_retrieve", error: result.body }, { status: result.status });
  }

  const status = result.status;
  const headers = {
    "X-Coze-Conversation-Id": conversationId,
    "X-Coze-Chat-Id": chatId,
    ...(COZE_INTERPRET_BOT_ID ? { "X-Coze-Bot-Id": COZE_INTERPRET_BOT_ID } : {}),
    ...(status ? { "X-Coze-Status": status } : {}),
  } as Record<string, string>;

  if (status === "FAILED" || status === "ERROR") {
    return Response.json(
      { step: "chat_retrieve", error: { msg: result.errorMessage ?? "Coze chat failed", status } },
      { status: 502, headers },
    );
  }

  if (status === "COMPLETED" || status === "DONE" || status === "SUCCESS") {
    return Response.json(
      { report_markdown: result.answer ?? "" },
      { status: 200, headers },
    );
  }

  return Response.json(
    { step: "chat_retrieve", status: status ?? "RUNNING", retryAfterMs: 1500 },
    { status: 202, headers: { ...headers, "Retry-After": "2" } },
  );
}
