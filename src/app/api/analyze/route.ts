const COZE_BASE_URL = (process.env.COZE_API_BASE ?? "https://api.coze.cn").replace(/\/+$/, "");
const COZE_API_TOKEN = process.env.COZE_API_TOKEN ?? "";
const COZE_BOT_ID = process.env.COZE_BOT_ID ?? "";

type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

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

function extractFileId(payload: unknown) {
  return findFirstString(payload, ["file_id", "fileId", "id", "ID"]);
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

function pickPreferredMessageContent(payload: unknown) {
  if (!payload || typeof payload !== "object") return { content: null as string | null, type: null as string | null };
  const rec = payload as Record<string, unknown>;
  const list = rec["data"];
  if (!Array.isArray(list)) return { content: null as string | null, type: null as string | null };
  const rows = list.filter((x) => x && typeof x === "object") as Record<string, unknown>[];
  const pick = (targetType: string) => {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i];
      const type = typeof row["type"] === "string" ? row["type"] : "";
      const content = typeof row["content"] === "string" ? row["content"].trim() : "";
      if (type === targetType && content.length > 0) {
        return content;
      }
    }
    return null;
  };
  const answer = pick("answer");
  if (answer) return { content: answer, type: "answer" };
  const tool = pick("tool_response");
  if (tool) return { content: tool, type: "tool_response" };
  const verbose = pick("verbose");
  if (verbose) return { content: verbose, type: "verbose" };
  return { content: null as string | null, type: null as string | null };
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

async function uploadToCoze(file: File) {
  const form = new FormData();
  form.set("file", file, file.name);
  const res = await cozeFetch(`${COZE_BASE_URL}/v1/files/upload`, {
    method: "POST",
    body: form,
  });
  const { json, text } = await readResponseBody(res);
  if (!res.ok) {
    return { ok: false as const, status: res.status, body: json ?? text };
  }
  const fileId = extractFileId(json ?? text);
  if (!fileId) {
    return { ok: false as const, status: 502, body: { msg: "Upload succeeded but file_id missing", raw: json ?? text } };
  }
  return { ok: true as const, fileId, raw: json ?? text };
}

async function createChatWithFallbacks(fileId: string) {
  if (!COZE_BOT_ID) {
    throw new Error("COZE_BOT_ID missing");
  }

  const userId = "ipis_web";
  const prompt =
    "请读取我上传的PDF附件，提取保单信息并输出结构化Markdown（包含清晰标题与表格）。";
  const messageContent = [
    { type: "text", text: prompt },
    { type: "file", file_id: fileId },
  ];
  const messageContentAlt = [
    { type: "text", text: prompt },
    { type: "file", fileId },
  ];

  const candidates: Array<Record<string, unknown>> = [
    {
      bot_id: COZE_BOT_ID,
      user_id: userId,
      stream: false,
      additional_messages: [
        {
          role: "user",
          content: JSON.stringify(messageContent),
          content_type: "object_string",
        },
      ],
    },
    {
      bot_id: COZE_BOT_ID,
      user_id: userId,
      stream: false,
      additional_messages: [
        {
          role: "user",
          content: JSON.stringify(messageContentAlt),
          content_type: "object_string",
        },
      ],
      meta_data: { file_id: fileId },
    },
    {
      bot_id: COZE_BOT_ID,
      user_id: userId,
      stream: false,
      additional_messages: [
        {
          role: "user",
          content: JSON.stringify(messageContent),
          content_type: "object_string",
        },
        { role: "user", content: prompt, content_type: "text" },
      ],
      meta_data: { fileId },
    },
  ];

  let lastError: { status: number; body: unknown } | null = null;

  for (const body of candidates) {
    const res = await cozeFetch(`${COZE_BASE_URL}/v3/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const { json, text } = await readResponseBody(res);
    if (!res.ok) {
      lastError = { status: res.status, body: json ?? text };
      continue;
    }

    const payload = json ?? text;
    const { conversationId, chatId } = extractChatIds(payload);
    if (!conversationId || !chatId) {
      lastError = { status: 502, body: { msg: "Chat created but ids missing", raw: payload } };
      continue;
    }
    return { ok: true as const, conversationId, chatId };
  }

  return { ok: false as const, error: lastError ?? { status: 502, body: { msg: "Chat create failed" } } };
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
    await new Promise((resolve) => setTimeout(resolve, 1000));
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
  const preferred = pickPreferredMessageContent(messageListPayload);
  const rawMessageText = JSON.stringify({
    messagesData: messageListPayload ?? null,
    preferred_content: preferred.content,
    preferred_type: preferred.type,
  });
  const errorMessage = extractErrorMessage(messageListPayload) ?? extractErrorMessage(retrievePayload);
  return {
    ok: true as const,
    payload: retrievePayload,
    status,
    rawMessageText,
    messagesData: messageListPayload,
    preferredType: preferred.type,
    errorMessage,
  };
}

export async function GET(req: Request) {
  if (!COZE_API_TOKEN) {
    return Response.json({ error: "Missing COZE_API_TOKEN" }, { status: 500 });
  }

  const url = new URL(req.url);
  const conversationId = url.searchParams.get("conversation_id") ?? url.searchParams.get("conversationId") ?? "";
  const chatId = url.searchParams.get("chat_id") ?? url.searchParams.get("chatId") ?? "";
  if (!conversationId || !chatId) {
    return Response.json({ error: "Missing conversation_id/chat_id" }, { status: 400 });
  }

  const result = await retrieveChatOnce(conversationId, chatId);
  if (!result.ok) {
    console.error("[api/analyze] chat_retrieve failed", result.status);
    return Response.json({ step: "chat_retrieve", error: result.body }, { status: result.status });
  }

  const status = result.status;
  const headers = {
    "X-Coze-Conversation-Id": conversationId,
    "X-Coze-Chat-Id": chatId,
    ...(COZE_BOT_ID ? { "X-Coze-Bot-Id": COZE_BOT_ID } : {}),
    ...(status ? { "X-Coze-Status": status } : {}),
  } as Record<string, string>;

  if (status === "FAILED" || status === "ERROR") {
    return Response.json(
      { step: "chat_retrieve", error: { msg: result.errorMessage ?? "Coze chat failed", status } },
      { status: 502, headers },
    );
  }

  if (status === "COMPLETED" || status === "DONE" || status === "SUCCESS") {
    return new Response(result.rawMessageText, {
      status: 200,
      headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
    });
  }

  return Response.json(
    { step: "chat_retrieve", status: status ?? "RUNNING", retryAfterMs: 1500 },
    { status: 202, headers: { ...headers, "Retry-After": "2" } },
  );
}

export async function POST(req: Request) {
  const startedAt = Date.now();
  if (!COZE_API_TOKEN || !COZE_BOT_ID) {
    return Response.json(
      { error: "Missing COZE_API_TOKEN or COZE_BOT_ID" },
      { status: 500 },
    );
  }

  const form = await req.formData();
  const fileLike = form.get("file") ?? form.get("pdf") ?? form.get("pdfFile");
  if (!(fileLike instanceof File)) {
    return Response.json({ error: "FormData must include a PDF file field named 'file'" }, { status: 400 });
  }
  if (fileLike.size <= 0) {
    return Response.json({ error: "Empty file" }, { status: 400 });
  }

  const upload = await uploadToCoze(fileLike);
  if (!upload.ok) {
    console.error("[api/analyze] upload failed", upload.status);
    return Response.json({ step: "upload", error: upload.body }, { status: upload.status });
  }

  const chat = await createChatWithFallbacks(upload.fileId);
  if (!chat.ok) {
    console.error("[api/analyze] chat_create failed", chat.error.status);
    return Response.json({ step: "chat_create", error: chat.error.body }, { status: chat.error.status });
  }

  console.log("[api/analyze] accepted", { elapsedMs: Date.now() - startedAt });
  return Response.json(
    {
      botId: COZE_BOT_ID,
      conversationId: chat.conversationId,
      chatId: chat.chatId,
      fileId: upload.fileId,
    },
    { status: 202, headers: { "X-Coze-Bot-Id": COZE_BOT_ID } },
  );
}

