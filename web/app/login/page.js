'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import AuthForm from '../../components/AuthForm';
import { supabase } from '../../lib/supabase';

export default function Login() {
  const router = useRouter();
  const [mode, setMode] = useState('login');

  // A session can appear outside the form submit path: returning from the
  // GitHub OAuth redirect, or visiting /login while already signed in.
  useEffect(() => {
    const sb = supabase();
    sb.auth.getSession().then(({ data }) => {
      if (data.session) router.replace('/feed');
    });
    const { data: sub } = sb.auth.onAuthStateChange((_event, session) => {
      if (session) router.replace('/feed');
    });
    return () => sub.subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="mx-auto max-w-sm px-6 py-24">
      <div className="mb-8 flex items-center gap-2 font-bold">
        <span className="inline-block h-6 w-6 rounded-lg bg-gradient-to-br from-blue-600 to-blue-400" />
        MemBridge
      </div>
      <h1 className="mb-1 text-2xl font-semibold">
        {mode === 'signup' ? 'Create your account' : 'Welcome back'}
      </h1>
      <p className="mb-6 text-sm text-slate-500">
        Same account as the MemBridge CLI — one login everywhere.
      </p>
      <AuthForm onDone={() => router.replace('/feed')} onModeChange={setMode} />
    </main>
  );
}
