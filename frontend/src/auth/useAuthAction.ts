import { useEffect, useRef, useState } from 'react';
import { ApiError, failure } from '../api/http';

/** Serializes an explicit form action and releases navigation before its outcome transition; never retries work. */
export function useAuthAction(lock: (busy: boolean) => void) {
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; lock(false); };
  }, [lock]);

  async function run(work: () => Promise<void>, succeeded: () => void, rejected: (error: ApiError) => void) {
    if (pending.current) return;
    pending.current = true; setBusy(true); lock(true);
    let error: ApiError | undefined;
    try { await work(); }
    catch (reason) { error = failure(reason); }
    finally {
      pending.current = false; lock(false);
      if (alive.current) setBusy(false);
    }
    if (alive.current) { if (error) rejected(error); else succeeded(); }
  }
  return { busy, run };
}
