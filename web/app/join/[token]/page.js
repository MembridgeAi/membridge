'use client';
import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import AuthForm from '../../../components/AuthForm';
import { supabase, displayNameOf } from '../../../lib/supabase';

// The invite landing: "You've been invited to Team X" -> inline signup/login
// -> auto-join -> install nudge -> feed. peek_invite exposes only the team
// name and validity, so this page is safe pre-auth.
export default function Join() {
  const { token } = useParams();
  const router = useRouter();
  const [peek, setPeek] = useState(undefined); // undefined loading, null unknown token
  const [user, setUser] = useState(null);
  const [joined, setJoined] = useState(null);
  const [error, setError] = useState('');
  const redeeming = useRef(false);

  useEffect(() => {
    const sb = supabase();
    sb.rpc('peek_invite', { p_token: token }).then(({ data, error }) => {
      if (error) {
        setError(error.message);
        setPeek(null);
        return;
      }
      setPeek(data && data.length ? data[0] : null);
    });
  }, [token]);

  // Fires for the session already in storage (INITIAL_SESSION), a password
  // login in the form, and the return leg of the GitHub OAuth redirect.
  useEffect(() => {
    const { data: sub } = supabase().auth.onAuthStateChange((_event, session) => {
      if (session?.user) setUser(session.user);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // Signed in + valid invite -> join straight away (idempotent server-side).
  useEffect(() => {
    if (user && peek && peek.valid && !joined) redeem(user);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, peek]);

  async function redeem(u) {
    if (redeeming.current) return;
    redeeming.current = true;
    const sb = supabase();
    const { data, error } = await sb.rpc('redeem_invite', {
      p_token: token,
      p_display_name: displayNameOf(u),
    });
    if (error) {
      redeeming.current = false;
      setError(error.message);
      return;
    }
    const t = data && data[0];
    if (t) {
      localStorage.setItem('membridge.team', t.team_id);
      setJoined(t);
    }
  }

  if (peek === undefined) return <p className="p-10 text-sm text-slate-500">Checking your invite…</p>;

  return (
    <main className="mx-auto max-w-md px-6 py-20">
      <div className="mb-8 flex items-center gap-2 font-bold">
        <span className="inline-block h-6 w-6 rounded-lg bg-gradient-to-br from-blue-600 to-blue-400" />
        MemBridge
      </div>

      {!peek && (
        <div className="rounded-2xl border border-slate-200 bg-white p-8">
          <h1 className="text-xl font-semibold">This invite link isn&rsquo;t valid</h1>
          <p className="mt-2 text-sm text-slate-500">
            It may have been revoked or mistyped. Ask your teammate for a fresh one.
          </p>
          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        </div>
      )}

      {peek && !peek.valid && (
        <div className="rounded-2xl border border-slate-200 bg-white p-8">
          <h1 className="text-xl font-semibold">This invite to {peek.team_name} has expired</h1>
          <p className="mt-2 text-sm text-slate-500">Ask your teammate for a fresh link.</p>
        </div>
      )}

      {peek && peek.valid && !joined && (
        <div className="rounded-2xl border border-slate-200 bg-white p-8">
          <p className="text-xs font-semibold uppercase tracking-widest text-blue-600">
            You&rsquo;ve been invited
          </p>
          <h1 className="mt-2 text-2xl font-semibold">Join {peek.team_name} on MemBridge</h1>
          <p className="mb-6 mt-2 text-sm text-slate-500">
            See what every AI coding tool on the team did — log in or create your account to jump
            into the feed.
          </p>
          <AuthForm defaultMode="signup" onDone={redeem} />
          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        </div>
      )}

      {joined && (
        <div className="rounded-2xl border border-slate-200 bg-white p-8">
          <h1 className="text-2xl font-semibold">You&rsquo;re in — welcome to {joined.team_name} 🎉</h1>
          <p className="mt-3 text-sm leading-relaxed text-slate-500">
            To contribute your own AI activity, install MemBridge on your machine and run one
            command:
          </p>
          <pre className="mt-3 overflow-x-auto rounded-lg bg-slate-900 p-4 text-xs leading-relaxed text-slate-100">
            {`npm install -g membridge\nmembridge join ${token}`}
          </pre>
          <p className="mt-2 text-xs text-slate-400">
            Or skip that for now — the feed works without installing anything.
          </p>
          <button
            onClick={() => router.replace('/feed')}
            className="mt-6 w-full rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white hover:bg-blue-700"
          >
            Open the team feed
          </button>
        </div>
      )}
    </main>
  );
}
