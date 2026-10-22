import { signup } from "../actions";
import Link from "next/link";
import { GoogleButton } from "../google-button";
import { authErrorCopy } from "../../auth/messages";
import { isLocalRuntime } from "@/lib/env";

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[]; min?: string | string[]; next?: string | string[] }>;
}) {
  // Next.js already URL-decodes searchParams values, so render as-is.
  const params = await searchParams;
  const error = Array.isArray(params.error) ? params.error[0] : params.error;
  const min = Array.isArray(params.min) ? params.min[0] : params.min;
  // See login/page.tsx's `next` comment — same pass-through.
  const next = Array.isArray(params.next) ? params.next[0] : params.next;

  if (!isLocalRuntime()) {
    return (
      <>
        <h1 className="mb-6 text-center text-2xl font-bold text-gray-100">Sign-ups are closed</h1>
        <p className="text-center text-sm text-gray-500">
          Sign-ups are closed. Existing accounts:{" "}
          <Link
            href={next ? `/login?next=${encodeURIComponent(next)}` : "/login"}
            className="text-blue-400 hover:text-blue-300"
          >
            sign in
          </Link>
          .
        </p>
      </>
    );
  }

  return (
    <>
      <h1 className="mb-6 text-center text-2xl font-bold text-gray-100">
        Create your account
      </h1>

      {error ? (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-300"
        >
          {authErrorCopy(error, min, "signup_failed")}
        </div>
      ) : null}

      <GoogleButton next={next} />

      <div className="my-4 flex items-center gap-3">
        <div className="h-px flex-1 bg-gray-800" />
        <span className="text-xs text-gray-500">or</span>
        <div className="h-px flex-1 bg-gray-800" />
      </div>

      <form action={signup} className="space-y-4">
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
            minLength={6}
            className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="••••••••"
          />
        </div>

        <button
          type="submit"
          className="w-full rounded-lg bg-blue-500 px-4 py-2 font-medium text-white transition hover:bg-blue-600"
        >
          Create account
        </button>
      </form>

      <p className="mt-4 text-center text-xs text-gray-500">
        By creating an account you agree to the{" "}
        <Link href="/terms" className="text-blue-400 hover:text-blue-300">
          Terms
        </Link>{" "}
        and{" "}
        <Link href="/privacy" className="text-blue-400 hover:text-blue-300">
          Privacy Policy
        </Link>
        .
      </p>

      <p className="mt-4 text-center text-sm text-gray-500">
        Already have an account?{" "}
        <Link
          href={next ? `/login?next=${encodeURIComponent(next)}` : "/login"}
          className="text-blue-400 hover:text-blue-300"
        >
          Sign in
        </Link>
      </p>
    </>
  );
}
