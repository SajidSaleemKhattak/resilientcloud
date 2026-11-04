import { useEffect, useState } from 'react';

export type Resource<T> = { data: T | null; loading: boolean; error: string | null; receivedAt: number | null };

/** Read-only, bounded requests. A failed refresh keeps last data explicitly disconnected. */
export function useResource<T>(url: string, parse: (value: unknown) => T, pollMs = 2000): Resource<T> {
  const [state, setState] = useState<Resource<T>>({ data: null, loading: true, error: null, receivedAt: null });
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController;
    async function refresh() {
      controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3500);
      try {
        const response = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error(`Read failed (HTTP ${response.status}).`);
        const body = await response.text();
        if (body.length > 2 * 1024 * 1024) throw new Error('Response exceeds the display limit.');
        const data = parse(JSON.parse(body));
        if (!stopped) setState({ data, loading: false, error: null, receivedAt: performance.now() });
      } catch (error) {
        if (!stopped) setState(previous => ({ ...previous, loading: false, error: error instanceof Error ? error.message : 'Connection failed.' }));
      } finally {
        clearTimeout(timeout);
        if (!stopped && pollMs > 0) timer = setTimeout(refresh, pollMs);
      }
    }
    void refresh();
    return () => { stopped = true; clearTimeout(timer); controller?.abort(); };
  }, [url, parse, pollMs]);
  return state;
}
