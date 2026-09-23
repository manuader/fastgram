/**
 * Las pantallas de identidad: copy literal del PRD §15.1–15.2, cada estado de
 * error con el mensaje que le toca, y a dónde se navega tras entrar.
 *
 * `fetch` es un doble con la forma de los handlers del BFF (`lib/auth/bff.ts`),
 * no de la API: la pantalla nunca habla con la API.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hardNavigate = vi.fn<(path: string) => void>();
vi.mock("@/lib/auth/navigate", () => ({
  hardNavigate: (path: string) => {
    hardNavigate(path);
  },
}));

const { LoginForm } = await import("./LoginForm");
const { SignupForm } = await import("./SignupForm");
const { LogoutScreen } = await import("./LogoutScreen");
const { ResetPasswordForm } = await import("./ResetPasswordForm");
const { ForgotPasswordForm } = await import("./ForgotPasswordForm");

let upstream: ReturnType<typeof vi.fn>;
beforeEach(() => {
  upstream = vi.fn();
  vi.stubGlobal("fetch", upstream);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function apiError(status: number, code: string, headers: Record<string, string> = {}) {
  return json(status, { error: { code, message: "server text, never shown" } }, headers);
}

const SIGNED_IN = (next: string) =>
  json(200, {
    data: { user: { id: "u1", email: "a@b.test", emailVerified: false }, next },
  });

async function fillLogin() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Email"), "a@b.test");
  await user.type(screen.getByLabelText("Password"), "hunter22");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("LoginForm", () => {
  it("copy literal de §15.1–15.2 y campos con label", () => {
    render(<LoginForm returnTo={null} sessionUnverified={false} />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Welcome back" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create an account" })).toHaveAttribute(
      "href",
      "/signup",
    );
    expect(screen.getByLabelText("Email")).toHaveAttribute("autocomplete", "email");
    expect(screen.getByLabelText("Password")).toHaveAttribute(
      "autocomplete",
      "current-password",
    );
    expect(screen.queryByText(/couldn't verify your session/)).toBeNull();
  });

  it("§15.2: sesión no verificable → el copy literal y reintentar vuelve a donde iba", () => {
    render(<LoginForm returnTo="/calendar" sessionUnverified />);
    expect(
      screen.getByText(
        "We couldn't verify your session. Try again, or sign in again if this continues.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Try again" })).toHaveAttribute(
      "href",
      "/calendar",
    );
  });

  it("éxito: navega a lo que dice el servidor (companyId null → /onboarding)", async () => {
    upstream.mockResolvedValue(SIGNED_IN("/onboarding"));
    render(<LoginForm returnTo="/calendar" sessionUnverified={false} />);
    await fillLogin();
    await waitFor(() => {
      expect(hardNavigate).toHaveBeenCalledWith("/onboarding");
    });
    const [, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      email: "a@b.test",
      password: "hunter22",
      returnTo: "/calendar",
    });
  });

  it("401: mensaje neutro, sin navegar y sin el texto del servidor", async () => {
    upstream.mockResolvedValue(apiError(401, "unauthorized"));
    render(<LoginForm returnTo={null} sessionUnverified={false} />);
    await fillLogin();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That email and password don't match an account.",
    );
    expect(hardNavigate).not.toHaveBeenCalled();
    expect(screen.queryByText(/server text/)).toBeNull();
    // El botón vuelve a estar disponible para corregir y reintentar.
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  it("429 con Retry-After dice cuánto esperar", async () => {
    upstream.mockResolvedValue(apiError(429, "rate_limited", { "retry-after": "30" }));
    render(<LoginForm returnTo={null} sessionUnverified={false} />);
    await fillLogin();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Too many attempts. Try again in 30 seconds.",
    );
  });

  it("503 → el servicio no responde", async () => {
    upstream.mockResolvedValue(apiError(503, "service_unavailable"));
    render(<LoginForm returnTo={null} sessionUnverified={false} />);
    await fillLogin();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That service isn't responding. Try again shortly.",
    );
  });

  it("campos vacíos: no llama a nadie", async () => {
    render(<LoginForm returnTo={null} sessionUnverified={false} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Fill in every field.");
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe("SignupForm", () => {
  async function fillSignup() {
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Full name"), "Ada Lovelace");
    await user.type(screen.getByLabelText("Email"), "a@b.test");
    await user.type(screen.getByLabelText("Password"), "hunter22");
    await user.click(screen.getByRole("button", { name: "Sign up" }));
  }

  it("enlace literal `Already have an account?` al login", () => {
    render(<SignupForm returnTo={null} />);
    expect(
      screen.getByRole("link", { name: "Already have an account?" }),
    ).toHaveAttribute("href", "/login");
    expect(screen.getByLabelText("Password")).toHaveAccessibleDescription(
      "Use at least 8 characters.",
    );
  });

  it("409: el email existe, y la salida es entrar", async () => {
    upstream.mockResolvedValue(apiError(409, "conflict"));
    render(<SignupForm returnTo={null} />);
    await fillSignup();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("An account with this email already exists.");
    expect(screen.getByRole("link", { name: "Sign in instead" })).toHaveAttribute(
      "href",
      "/login",
    );
    expect(hardNavigate).not.toHaveBeenCalled();
  });

  it("201 → /onboarding", async () => {
    upstream.mockResolvedValue(
      json(201, {
        data: {
          user: { id: "u", email: "a@b.test", emailVerified: false },
          next: "/onboarding",
        },
      }),
    );
    render(<SignupForm returnTo={null} />);
    await fillSignup();
    await waitFor(() => {
      expect(hardNavigate).toHaveBeenCalledWith("/onboarding");
    });
  });
});

describe("LogoutScreen", () => {
  it("sale una sola vez al montar y va al login", async () => {
    upstream.mockResolvedValue(new Response(null, { status: 204 }));
    render(<LogoutScreen />);
    await waitFor(() => {
      expect(hardNavigate).toHaveBeenCalledWith("/login");
    });
    expect(upstream).toHaveBeenCalledTimes(1);
    const [url] = upstream.mock.calls[0] as [string];
    expect(url).toBe("/api/fastgram/auth/logout");
  });

  it("si el POST no llega, no finge: error y reintentar", async () => {
    upstream.mockRejectedValueOnce(new TypeError("fetch failed"));
    render(<LogoutScreen />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong");
    expect(hardNavigate).not.toHaveBeenCalled();
    upstream.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => {
      expect(hardNavigate).toHaveBeenCalledWith("/login");
    });
  });
});

describe("recuperación · §15.3", () => {
  it("forgot: la confirmación no dice si la cuenta existe", async () => {
    upstream.mockResolvedValue(new Response(null, { status: 202 }));
    render(<ForgotPasswordForm />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Email"), "a@b.test");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "If an account exists for that email, we've sent a link to reset your password.",
    );
  });

  it("reset sin token: enlace inválido y salida a pedir otro", () => {
    render(<ResetPasswordForm token={null} />);
    expect(screen.getByRole("alert")).toHaveTextContent("invalid or has expired");
    expect(screen.getByRole("link", { name: "Request a new link" })).toHaveAttribute(
      "href",
      "/forgot-password",
    );
    expect(screen.getByRole("button", { name: "Update password" })).toBeDisabled();
  });

  it("reset 400 → enlace inválido; 204 → pide entrar con la nueva", async () => {
    upstream.mockResolvedValueOnce(apiError(400, "bad_request"));
    render(<ResetPasswordForm token="tok" />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("New password"), "hunter22");
    await user.click(screen.getByRole("button", { name: "Update password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("invalid or has expired");

    upstream.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await user.click(screen.getByRole("button", { name: "Update password" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Your password was updated. Sign in with your new password.",
    );
  });
});
