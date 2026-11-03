import { useCallback, useEffect, useState } from 'react';

/** Tracks just the two real routes using browser history, without storing account or request data there. */
export function useRoute() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  const navigate = useCallback((next: '/' | '/login', replace = false) => {
    if (window.location.pathname === next) return;
    window.history[replace ? 'replaceState' : 'pushState'](null, '', next);
    setPath(next);
  }, []);
  return { path, navigate };
}
