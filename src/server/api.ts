import { NextResponse } from "next/server";
import { HttpError } from "./errors";

const BODY_LIMIT = 1024 * 1024;

export async function readJson(request: Request) {
  const contentType = request.headers.get("content-type")?.split(";")[0].trim();
  if (contentType !== "application/json") {
    throw new HttpError(415, "Content-Type deve ser application/json.");
  }
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > BODY_LIMIT) {
    throw new HttpError(413, "Requisição muito grande.");
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > BODY_LIMIT) {
    throw new HttpError(413, "Requisição muito grande.");
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "JSON inválido.");
  }
}

export function json(data: unknown, status = 200) {
  const response = NextResponse.json(data, { status });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}

export async function api(
  handler: () => Promise<Response> | Response
): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ error: error.code, message: error.message }, error.status);
    }
    console.error("Erro interno na API:", error instanceof Error ? error.stack : error);
    return json(
      { error: "internal_error", message: "Erro interno do servidor." },
      500
    );
  }
}

export function setSessionCookie(
  response: NextResponse,
  token: string,
  secure: boolean
) {
  response.cookies.set("notes_session", token, {
    httpOnly: true,
    sameSite: "strict",
    secure,
    path: "/"
  });
}

export function clearSessionCookie(response: NextResponse, secure: boolean) {
  response.cookies.set("notes_session", "", {
    httpOnly: true,
    sameSite: "strict",
    secure,
    path: "/",
    expires: new Date(0)
  });
}
