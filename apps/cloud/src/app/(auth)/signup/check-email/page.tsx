import Link from "next/link";
import { authErrorCopy } from "../../../auth/messages";
import { resendConfirmation } from "../../actions";

// Issue #127 (D9): shown after a successful signUp() that returned no
// session — email confirmation is ON for this deployment (hosted; local dev
// leaves confirmations off, so the signup action never redirects here
// locally — see (auth)/actions.ts's signup()). No user id/email is passed
// through the URL on purpose: nothing here is personalized, and passing it
// through would leak a signup attempt's email into referrer headers/logs.
// (Adversarial review round 1, minor m2: because of that same gating, this
// page is only ever reached via a path where GoTrue actually is issuing
// confirmation emails — a signup with confirmations off always returns a
// session and never redirects here at all — so its "we sent a link" framing
// can't go stale for a self-hoster running with confirmations disabled.)
//
// Issue #133: also the landing spot for a RESUBMIT that hits GoTrue's
// per-address ~60s post-signup cooldown (`over_email_send_rate_limit`) —
// the account was already created and the confirmation email already sent
// on the first submit, so this is not a failure. `?resent=1` distinguishes
// that case from a fresh first-time signup so the copy doesn't wrongly
// imply a second email just went out.
//
// Adversarial review round 1, minor m1: this page used to promise "you can
// request another link about a minute after the first one" with nothing on
// the page that actually did that. The form below (resendConfirmation() in
// ../../actions) is that mechanism — the visitor re-enters their email
// since this page never carries one in the URL (see above).
//
// Adversarial review round 2, minor R2-m2: `errorRaw` (a failed resend —
// resendConfirmation() redirects back here with `?error=`) used to render
// BELOW the unconditional emerald checkmark and "Account created" heading,
// so a failed resend read as a success icon, a success headline, and an
// error box stacked on top of each other — the same "reads as the opposite
// of what happened" confusion #133 exists to fix, inverted. When `errorRaw`
// is set, the success iconography and the (now-irrelevant, since it's not
// what the visitor is being told about) "we sent a link" paragraph are
// both suppressed; the heading states the failure directly instead.
export default async function CheckEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ resent?: string | string[]; error?: string | string[] }>;
}) {
  const params = await searchParams;
  const resentRaw = Array.isArray(params.resent) ? params.resent[0] : params.resent;
  const resent = resentRaw === "1";
  const errorRaw = Array.isArray(params.error) ? params.error[0] : params.error;
  const hasError = Boolean(errorRaw);

  return (
    <>
      {hasError ? null : (
        <div className="mb-4 flex justify-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-400">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-6 w-6"
              aria-hidden="true"
            >
              <title>Success</title>
              <path d="M20 6 9 17l-5-5" />
            </svg>
          </div>
        </div>
      )}

      <h1 className="mb-4 text-center text-2xl font-bold text-gray-100">
        {hasError
          ? "Couldn't resend the confirmation link"
          : resent
            ? "Confirmation link already sent"
            : "Check your email"}
      </h1>

      {hasError ? null : resent ? (
        <p className="text-center text-sm text-gray-400">
          We already sent a confirmation link to that address a moment ago. Give it a minute, then check your inbox
          (and spam folder).
        </p>
      ) : (
        <p className="text-center text-sm text-gray-400">
          We sent a confirmation link to the email address you signed up with. Check your inbox — and your spam
          folder, if it doesn't show up in a minute — then click the link to activate your account and sign in.
        </p>
      )}

      {errorRaw ? (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-300"
        >
          {authErrorCopy(errorRaw, null, "resend_failed")}
        </div>
      ) : null}

      <form action={resendConfirmation} className="mt-6 space-y-2">
        <label htmlFor="resend-email" className="block text-center text-xs text-gray-500">
          Didn&apos;t get it? Enter your email to resend the confirmation link.
        </label>
        <input
          id="resend-email"
          name="email"
          type="email"
          required
          placeholder="you@example.com"
          className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-center text-sm text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <button
          type="submit"
          className="w-full rounded-lg border border-gray-700 px-4 py-2 text-sm font-medium text-gray-300 transition hover:bg-gray-800"
        >
          Resend confirmation link
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-gray-500">
        <Link href="/login" className="text-blue-400 hover:text-blue-300">
          Back to sign in
        </Link>
      </p>
    </>
  );
}
