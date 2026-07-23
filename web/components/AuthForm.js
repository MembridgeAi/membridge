'use client';
import { useState } from 'react';
import { supabase } from '../lib/supabase';

// Inline login/signup used by /login and the /join/<token> landing.
// onDone(user) fires once a session exists. GitHub sign-in leaves the page
// entirely (OAuth redirect) — the host page's onAuthStateChange listener,
// not onDone, picks the session up when GitHub sends the user back here.
export default function AuthForm({ onDone, defaultMode = 'login', onModeChange }) {
  const [mode, setMode] = useState(defaultMode);

  function switchMode(next) {
    setMode(next);
    if (onModeChange) onModeChange(next);
  }
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const signup = mode === 'signup';

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const sb = supabase();
      if (signup) {
        const { data, error } = await sb.auth.signUp({
          email,
          password,
          options: { data: { display_name: name || email.split('@')[0] } },
        });
        if (error) throw error;
        if (!data.session) {
          setNotice(`Check ${email} for a confirmation link, then log in here.`);
          switchMode('login');
          return;
        }
        onDone(data.session.user);
      } else {
        const { data, error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
        onDone(data.session.user);
      }
    } catch (err) {
      setError(err.message || 'Something went wrong — try again.');
    } finally {
      setBusy(false);
    }
  }

  async function githubSignIn() {
    setBusy(true);
    setError('');
    try {
      // redirectTo keeps the user on the page they started from (/login or
      // /join/<token>), so invite auto-redeem still happens after the round trip.
      const { error } = await supabase().auth.signInWithOAuth({
        provider: 'github',
        options: { redirectTo: window.location.href },
      });
      if (error) throw error;
      // Success navigates away; leave busy on until the redirect happens.
    } catch (err) {
      setError(err.message || 'Something went wrong — try again.');
      setBusy(false);
    }
  }

  const inputCls =
    'rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100';

  return (
    <form onSubmit={submit} className="grid gap-4">
      <div className="grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1">
        <button
          type="button"
          onClick={() => switchMode('login')}
          className={`rounded-lg px-3 py-2 text-sm font-semibold ${!signup ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
        >
          Log in
        </button>
        <button
          type="button"
          onClick={() => switchMode('signup')}
          className={`rounded-lg px-3 py-2 text-sm font-semibold ${signup ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
        >
          Create account
        </button>
      </div>

      <button
        type="button"
        onClick={githubSignIn}
        disabled={busy}
        className="flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-900 hover:bg-slate-50 disabled:opacity-50"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4 fill-current">
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.42 7.42 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
        </svg>
        Continue with GitHub
      </button>

      <div className="flex items-center gap-3 text-xs text-slate-400">
        <span className="h-px flex-1 bg-slate-200" />
        or use email
        <span className="h-px flex-1 bg-slate-200" />
      </div>

      {signup && (
        <label className="grid gap-1.5">
          <span className="text-sm font-medium text-slate-700">Display name</span>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="How teammates see you"
            className={inputCls}
            required
          />
        </label>
      )}
      <label className="grid gap-1.5">
        <span className="text-sm font-medium text-slate-700">Email</span>
        <input
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          placeholder="you@company.com"
          autoComplete="email"
          className={inputCls}
          required
        />
      </label>
      <label className="grid gap-1.5">
        <span className="text-sm font-medium text-slate-700">Password</span>
        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder={signup ? 'Choose a password' : 'Your password'}
          autoComplete={signup ? 'new-password' : 'current-password'}
          className={inputCls}
          required
        />
        {signup && (
          <span className="text-xs text-slate-500">
            A new password just for MemBridge — at least 6 characters.
          </span>
        )}
      </label>
      {notice && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</p>}
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <button
        disabled={busy}
        className="rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {busy ? 'One moment…' : signup ? 'Create my account' : 'Log in'}
      </button>
    </form>
  );
}
