import { signInWithGoogle } from "./actions";

// Issue #134: shared "Continue with Google" button for /login and /signup —
// same action, same markup either way (see signInWithGoogle()'s comment in
// actions.ts for why one action covers both entry points). Hand-rolled per
// CLAUDE.md (no component library); the "G" mark is inline SVG (no external
// asset — the CDN allowlist elsewhere in this repo doesn't apply to the app
// itself, but there's no reason to add an image request for four colored
// paths).
export function GoogleButton({ next }: { next?: string }) {
  return (
    <form action={signInWithGoogle}>
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <button
        type="submit"
        className="flex w-full items-center justify-center gap-2 rounded-xl border border-gray-700 bg-gray-100 px-4 py-2 font-medium text-gray-900 transition hover:bg-white"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" className="h-5 w-5" aria-hidden="true">
          <title>Google</title>
          <path
            fill="#EA4335"
            d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
          />
          <path
            fill="#4285F4"
            d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.9-2.26 5.35-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
          />
          <path
            fill="#FBBC05"
            d="M10.53 28.59A14.5 14.5 0 0 1 9.5 24c0-1.59.27-3.13.76-4.59l-7.98-6.19A23.94 23.94 0 0 0 0 24c0 3.86.92 7.51 2.56 10.78z"
          />
          <path
            fill="#34A853"
            d="M24 48c6.48 0 11.92-2.14 15.89-5.82l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
          />
        </svg>
        Continue with Google
      </button>
    </form>
  );
}
