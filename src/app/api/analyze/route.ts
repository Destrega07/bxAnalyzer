import { spawn } from "child_process";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

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

function extractPasswordField(form: FormData) {
  const raw = form.get("password") ?? form.get("pdf_password") ?? form.get("pdfPassword");
  if (typeof raw === "string") return raw;
  return "";
}

function encodeRFC5987ValueChars(str: string) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => {
    return `%${c.charCodeAt(0).toString(16).toUpperCase()}`;
  });
}

function buildAttachmentContentDisposition(filename: string) {
  const cleaned = filename.replace(/[/\\]/g, "_").replace(/["\r\n]/g, "").trim() || "report.pdf";
  const ascii = cleaned.replace(/[^\x20-\x7E]/g, "_");
  const encoded = encodeRFC5987ValueChars(cleaned);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function looksLikePdf(bytes: Uint8Array) {
  if (bytes.length < 5) return false;
  return Buffer.from(bytes.slice(0, 5)).toString("ascii") === "%PDF-";
}

function detectPdfEncryptedFromBytes(bytes: Uint8Array) {
  const windowSize = Math.min(bytes.length, 1024 * 1024);
  const head = Buffer.from(bytes.slice(0, windowSize)).toString("latin1");
  const tail = Buffer.from(bytes.slice(Math.max(0, bytes.length - windowSize))).toString("latin1");
  return head.includes("/Encrypt") || tail.includes("/Encrypt");
}

type CommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  errorCode?: string;
  errorMessage?: string;
};

async function runCommand(exe: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn> | null = null;
    try {
      child = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err ?? "");
      resolve({ ok: false, stdout: "", stderr: "", code: null, errorCode: "SPAWN_THROW", errorMessage: msg });
      return;
    }
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on("data", (d) => stdoutChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    child.stderr?.on("data", (d) => stderrChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    child.on("error", (err) => {
      const msg = err instanceof Error ? err.message : String(err ?? "");
      const code = typeof (err as { code?: unknown }).code === "string" ? String((err as { code?: unknown }).code) : "";
      resolve({
        ok: false,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        code: null,
        errorCode: code || "SPAWN_ERROR",
        errorMessage: msg,
      });
    });
    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      resolve({ ok: code === 0, stdout, stderr, code });
    });
  });
}

function isLocalDevHost(host: string | null) {
  if (!host) return false;
  const h = host.toLowerCase();
  return h.includes("localhost") || h.includes("127.0.0.1");
}

async function checkQpdfAvailable() {
  const r = await runCommand("qpdf", ["--version"]);
  if (r.ok) return { ok: true as const };
  const missing = r.errorCode === "ENOENT";
  return { ok: false as const, missing, detail: r.errorMessage || r.stderr || r.stdout || "" };
}

async function decryptPdfWithQpdf(bytes: Uint8Array, password: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "ipis-pdf-"));
  const inputPath = path.join(dir, "input.pdf");
  const outputPath = path.join(dir, "output.pdf");
  try {
    await writeFile(inputPath, Buffer.from(bytes));
    const result = await runCommand("qpdf", [
      `--password=${password}`,
      "--decrypt",
      inputPath,
      outputPath,
    ]);
    if (!result.ok) {
      if (result.errorCode === "ENOENT") {
        return { ok: false as const, unsupported: true, stderr: "" };
      }
      const stderr = result.stderr || result.stdout || "";
      const lowered = stderr.toLowerCase();
      const isPasswordError =
        lowered.includes("invalid password") ||
        lowered.includes("incorrect password") ||
        lowered.includes("bad password") ||
        lowered.includes("password");
      return { ok: false as const, passwordError: isPasswordError, stderr };
    }
    const out = await readFile(outputPath);
    return { ok: true as const, bytes: new Uint8Array(out) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function maybeDecryptIncomingPdf(file: File, password: string, opts: { host: string | null }) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!looksLikePdf(bytes)) {
    return {
      ok: false as const,
      error: { code: "PDF_INVALID", msg: "文件不是有效的 PDF" },
      status: 400,
    };
  }

  const encrypted = detectPdfEncryptedFromBytes(bytes);
  if (!encrypted) {
    return { ok: true as const, file, bytes };
  }

  const qpdf = await checkQpdfAvailable();
  if (!qpdf.ok) {
    const devLocal = process.env.NODE_ENV !== "production" && isLocalDevHost(opts.host);
    if (devLocal) {
      return {
        ok: false as const,
        error: { code: "QPDF_MISSING", msg: "本地环境缺少 qpdf，请先安装" },
        status: 500,
      };
    }
    return {
      ok: false as const,
      error: { code: "PDF_DECRYPT_UNSUPPORTED", msg: "服务端未安装PDF解密组件" },
      status: 500,
    };
  }

  const trimmedPassword = password.trim();
  const decrypted = await decryptPdfWithQpdf(bytes, trimmedPassword);
  if (!decrypted.ok) {
    if ("unsupported" in decrypted && decrypted.unsupported) {
      return {
        ok: false as const,
        error: { code: "PDF_DECRYPT_UNSUPPORTED", msg: "服务端未安装PDF解密组件" },
        status: 500,
      };
    }
    if (decrypted.passwordError) {
      if (!trimmedPassword.length) {
        return {
          ok: false as const,
          error: { code: "PDF_PASSWORD_REQUIRED", msg: "PDF已加密，请输入查询密码" },
          status: 400,
        };
      }
      return {
        ok: false as const,
        error: { code: "PDF_PASSWORD_INCORRECT", msg: "密码错误" },
        status: 400,
      };
    }
    return {
      ok: false as const,
      error: { code: "PDF_DECRYPT_FAILED", msg: decrypted.stderr || "PDF解密失败" },
      status: 502,
    };
  }

  const outFile = new File([decrypted.bytes], file.name, { type: file.type || "application/pdf" });
  return { ok: true as const, file: outFile, bytes: decrypted.bytes };
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

  const url = new URL(req.url);
  const form = await req.formData();
  const password = extractPasswordField(form);
  const debugDownloadRaw = url.searchParams.get("debug_download") ?? form.get("debug_download");
  const debugDownload =
    typeof debugDownloadRaw === "string" &&
    ["1", "true", "yes", "on"].includes(debugDownloadRaw.trim().toLowerCase());
  const fileLike = form.get("file") ?? form.get("pdf") ?? form.get("pdfFile");
  if (!(fileLike instanceof File)) {
    return Response.json({ error: "FormData must include a PDF file field named 'file'" }, { status: 400 });
  }
  if (fileLike.size <= 0) {
    return Response.json({ error: "Empty file" }, { status: 400 });
  }

  const maybeDecrypted = await maybeDecryptIncomingPdf(fileLike, password, { host: req.headers.get("host") });
  if (!maybeDecrypted.ok) {
    return Response.json({ step: "decrypt", error: maybeDecrypted.error }, { status: maybeDecrypted.status });
  }

  if (debugDownload) {
    const filenameBase = fileLike.name.replace(/\.pdf$/i, "");
    const filename = `${filenameBase || "report"}-decrypted.pdf`;
    const contentDisposition = buildAttachmentContentDisposition(filename);
    return new Response(Buffer.from(maybeDecrypted.bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": contentDisposition,
        "Cache-Control": "no-store",
      },
    });
  }

  const upload = await uploadToCoze(maybeDecrypted.file);
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
