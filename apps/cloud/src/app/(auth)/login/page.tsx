import { createClient } from "@/lib/supabase/server";
import { login } from "../actions";
import Link from "next/link";
import { GoogleButton } from "../google-button";
import { authErrorCopy } from "../../auth/messages";
import { isLocalRuntime } from "@/lib/env";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[]; min?: string | string[]; next?: string | string[] }>;
}) {
  // Next.js already URL-decodes searchParams values, so render as-is.
  const params = await searchParams;
  const error = Array.isArray(params.error) ? params.error[0] : params.error;
  const min = Array.isArray(params.min) ? params.min[0] : params.min;
  // Middleware lets a signed-in visitor reach /login when ?error is present;
  // offer the way back instead of leaving them on a sign-in form.
  let signedIn = false;
  if (error) {
    try {
      const supabase = await createClient();
      const { data } = await supabase.auth.getUser();
      signedIn = Boolean(data?.user);
    } catch {
      signedIn = false;
    }
  }
  // Where to send the user after a successful sign-in — set by middleware's
  // ?next=... when it bounced them off a protected route (e.g. /device for
  // CLI device-code sign-in). login() in ../actions re-validates this
  // server-side before ever redirecting to it.
  const next = Array.isArray(params.next) ? params.next[0] : params.next;

  return (
    <>
      <h1 className="mb-6 text-center text-2xl font-bold text-gray-100">
        Sign in to Membral
      </h1>

      {error ? (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-300"
        >
          {authErrorCopy(error, min)}
          {error === "email_not_confirmed" ? (
            <>
              {" "}
              <Link href="/signup/check-email" className="font-medium text-accent underline">
                Resend the confirmation link
              </Link>
            </>
          ) : null}
        </div>
      ) : null}

      {signedIn ? (
        <p className="mb-4 text-center text-sm">
          <Link href="/pulse" className="font-medium text-accent underline">
            Continue to your dashboard
          </Link>
        </p>
      ) : null}

      <GoogleButton next={next} />

      <div className="my-4 flex items-center gap-3">
        <div className="h-px flex-1 bg-gray-800" />
        <span className="text-xs text-gray-500">or</span>
        <div className="h-px flex-1 bg-gray-800" />
      </div>

      <form action={login} className="space-y-4">
        {next ? <input type="hidden" name="next" value={next} /> : null}
        <div>
          <label
            htmlFor="email"
            className="mb-1 block text-sm font-medium text-gray-400"
          >
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="you@example.com"
          />
        </div>

        <div>
          <label
            htmlFor="password"
            className="mb-1 block text-sm font-medium text-gray-400"
          >
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="••••••••"
          />
        </div>

        <button
          type="submit"
          className="w-full rounded-lg bg-blue-500 px-4 py-2 font-medium text-white transition hover:bg-blue-600"
        >
          Sign in
        </button>
      </form>

      {isLocalRuntime() ? (
      <p className="mt-4 text-center text-sm text-gray-500">
        Don&apos;t have an account?{" "}
        <Link
          href={next ? `/signup?next=${encodeURIComponent(next)}` : "/signup"}
          className="text-blue-400 hover:text-blue-300"
        >
          Sign up
        </Link>
      </p>
      ) : null}
    </>
  );
}
