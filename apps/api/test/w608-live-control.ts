// Only the isolated live server imports this adapter. It is not a production route.
import { StaffMeSchema } from "@liyoxi/contract";
import { W608LiveCommandSchema } from "@liyoxi/services/testing";
import type { W608LiveScope } from "@liyoxi/services/testing";

export async function handleW608LiveControl(input: {
  request: Request;
  scope?: W608LiveScope;
  controller?: { run(raw: unknown): Promise<unknown> };
  closing: boolean;
  fetch(request: Request): Promise<Response> | Response;
}): Promise<Response> {
  const { request, scope, controller } = input;
  const reject = (status: number) => Response.json({ error: "W608_CONTROL_REJECTED" }, { status });
  if (!scope || !controller) return reject(404);
  if (input.closing) return reject(410);
  if (request.method !== "POST") return reject(405);
  if (
    request.headers.get("Origin") !== new URL(request.url).origin ||
    request.headers.get("X-LYX-Admin") !== "1"
  )
    return reject(403);
  const headers = new Headers(request.headers);
  for (const name of ["content-length", "content-type", "transfer-encoding"]) headers.delete(name);
  try {
    const me = await input.fetch(
      new Request(new URL("/api/v1/admin/auth/me", request.url), { headers }),
    );
    if (!me.ok) return reject(403);
    const body: unknown = await me.json();
    const parsed = StaffMeSchema.safeParse(
      typeof body === "object" && body !== null && "data" in body ? body.data : undefined,
    );
    if (!parsed.success || parsed.data.staff.staffId !== scope.uploaderId) return reject(403);
  } catch {
    return reject(403);
  }
  const command = W608LiveCommandSchema.safeParse(await request.json().catch(() => undefined));
  if (!command.success) return reject(400);
  try {
    return Response.json({ data: await controller.run(command.data) });
  } catch {
    return reject(409);
  }
}
