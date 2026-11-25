import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ReviewApp from './ReviewApp';
import { ensureBounded } from './transport';
import type { ReviewRequest, UiTransport } from '../core/contracts';
import type { ReviewNavigation } from '../core/review-navigation';
import { surfaceStamp, type SurfaceReply } from '../core/review-surface-protocol';
import './theme.css';
interface Appearance { locale?: string; base?: 'light' | 'dark' }
interface Bridge { invoke<T = unknown>(method: string, args?: unknown): Promise<T>; on?(event: string, callback: (data: any) => void): (() => void) | void }
declare global { interface Window { pluginBridge?: Bridge } }
export function Panel() {
  const [appearance, setAppearance] = useState<Appearance>(() => ({ base: document.documentElement.dataset.base === 'dark' || (!document.documentElement.dataset.base && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light' }));
  const [route, setRoute] = useState<unknown>(() => new URLSearchParams(location.search).get('piViewOpen'));
  const [navigationBySession, setNavigationBySession] = useState<Record<string, ReviewNavigation>>({});
  const [cachedSessions, setCachedSessions] = useState<string[]>([]);
  const [error, setError] = useState(''), [selecting, setSelecting] = useState(Boolean(route));
  const [retry, setRetry] = useState(0), [fallback, setFallback] = useState(false);
  const readySession = useRef('');
  const resolvedSelection = useRef<Record<string, string>>({});
  const [surface, setSurface] = useState<SurfaceReply | null>(null);
  const [surfaceError, setSurfaceError] = useState('');
  const [connecting, setConnecting] = useState(true);
  const appliedSurface = useRef<string>();
  const previousSurface = useRef<string>();
  const wakeSurface = useRef<() => void>();
  const transport = useMemo<UiTransport>(() => ensureBounded({ invoke<T>(method: string, args?: unknown) {
    if (!window.pluginBridge) return Promise.reject(new Error('PI-Desktop 桥接不可用。'));
    return window.pluginBridge.invoke<T>(`diff.${method}`, args);
  } }), []);
  const effectiveRoute = surface ? surface.state === 'ready' && surface.sessionId ? `${surface.nonce ? `diff-view:${surface.nonce}` : `diff-session:${encodeURIComponent(surface.sessionId)}`}?sessionId=${encodeURIComponent(surface.sessionId)}` : '' : route;
  const [target, query = ''] = typeof effectiveRoute === 'string' ? effectiveRoute.split('?') : ['', ''];
  const sessionId = surface ? surface.state === 'ready' ? surface.sessionId ?? '' : '' : new URLSearchParams(query).get('sessionId') ?? new URLSearchParams(location.search).get('sessionId') ?? '';
  useEffect(() => {
    const id = crypto.randomUUID(); let seq = 0, live = true, pendingSeq = 0, after: string | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (interrupt = false) => {
      if (!live || (pendingSeq && !interrupt)) return;
      const stamp = ++seq, started = Date.now(); pendingSeq = stamp; let failed = false;
      try {
        const value = await transport.invoke<SurfaceReply>('reviewSurface', { role: 'view', id, seq: stamp, ack: appliedSurface.current, after, waitMs: 1000 });
        if (!live || stamp !== seq) return;
        if (!value || !['ready', 'waiting', 'ambiguous'].includes(value.state)) { failed = true; return; }
        after = surfaceStamp(value);
        setSurface(previous => previous && surfaceStamp(previous) === after ? previous : value);
        setSurfaceError(value.state === 'ambiguous' ? '存在多个窗口或审查视图，无法唯一绑定；请只保留一个窗口和审查视图。' : '');
      } catch (error) { failed = true; if (live && stamp === seq) { setSurface(previous => previous ? { state: 'waiting', sessionId: null } : previous); setSurfaceError(`会话导航桥接暂不可用：${String((error as Error).message)}`); } }
      finally { if (pendingSeq === stamp) pendingSeq = 0; if (live && stamp === seq) { setConnecting(false); timer = setTimeout(() => void poll(), failed ? 1500 : Math.max(0, 50 - (Date.now() - started))); } }
    };
    wakeSurface.current = () => { if (!live) return; if (timer) clearTimeout(timer); void poll(true); };
    void poll();
    return () => { live = false; wakeSurface.current = undefined; if (timer) clearTimeout(timer); void transport.invoke('reviewSurface', { role: 'view', id, seq: ++seq, release: true }).catch(() => {}); };
  }, [transport]);
  useEffect(() => {
    if (!surface?.key || previousSurface.current === surface.key) return;
    previousSurface.current = surface.key; setError(''); setFallback(false);
  }, [surface?.key]);
  useEffect(() => {
    const dispose = window.pluginBridge?.on?.('view:open', value => {
      setError(''); setSelecting(typeof value?.path === 'string' && value.path.startsWith('diff-view:')); setFallback(false);
      setRoute(value?.path); setRetry(n => n + 1);
    });
    return () => { if (typeof dispose === 'function') dispose(); };
  }, []);
  useEffect(() => {
    let live = true, changed = false;
    const update = (value: Appearance) => {
      if (!live) return;
      setAppearance(previous => ({ locale: value?.locale || previous.locale, base: value?.base === 'light' || value?.base === 'dark' ? value.base : previous.base }));
    };
    const dispose = window.pluginBridge?.on?.('appearance:changed', value => { changed = true; update(value); });
    window.pluginBridge?.invoke<Appearance>('app.getAppearance').then(value => { if (!changed) update(value); }).catch(() => undefined);
    return () => { live = false; if (typeof dispose === 'function') dispose(); };
  }, []);
  useEffect(() => {
    if (appearance.locale) document.documentElement.lang = appearance.locale;
    if (appearance.base) document.documentElement.dataset.base = appearance.base;
  }, [appearance]);
  useEffect(() => {
    let live = true, pending = false;
    setError(''); setSelecting(false);
    if (fallback || effectiveRoute == null || effectiveRoute === '') return;
    if (typeof effectiveRoute !== 'string') { setError('无效的视图定位参数'); return; }
    if (!sessionId) { setError('旧版视图没有会话标识，请从当前会话重新打开差异审查。'); return; }
    if (target === `diff-session:${encodeURIComponent(sessionId)}`) return;
    if (!/^diff-view:[0-9a-f-]{36}$/i.test(target)) { setError('无效的文件选择'); return; }
    const cached = navigationBySession[sessionId];
    if (surface?.nonce && cached?.nonce === surface.nonce && cached.revision === surface.selectionRevision) { resolvedSelection.current[sessionId] = target; return; }
    const load = async () => {
      if (pending || !live) return;
      pending = true;
      try {
        const selected = await transport.invoke<ReviewNavigation>('readTurnSelection', { nonce: target.slice('diff-view:'.length), sessionId });
        if (!live) return;
        if (selected.sessionId !== sessionId || selected.request.sessionId !== sessionId) throw new Error('所选记录不属于当前会话。');
        if (surface?.selectionRevision && selected.revision !== surface.selectionRevision) throw new Error('文件选择已变化，等待新的定位请求。');
        setNavigationBySession(previous => previous[sessionId]?.nonce === selected.nonce && previous[sessionId]?.revision === selected.revision ? previous : { ...previous, [sessionId]: selected });
        resolvedSelection.current[sessionId] = target;
        setError('');
      } catch (err) { if (live) { if (resolvedSelection.current[sessionId] !== target) setNavigationBySession(previous => { const next = { ...previous }; delete next[sessionId]; return next; }); setError(String((err as Error)?.message ?? err)); } }
      finally { pending = false; if (live) setSelecting(false); }
    };
    setSelecting(true); void load();
    const timer = !surface ? setInterval(() => { if (document.visibilityState !== 'hidden') void load(); }, 1500) : undefined;
    return () => { live = false; clearInterval(timer); };
  }, [transport, effectiveRoute, target, sessionId, retry, fallback, surface?.key]);
  if (sessionId && !selecting && !error) readySession.current = sessionId;
  const retainReview = readySession.current === sessionId && resolvedSelection.current[sessionId] === target;
  const targetResolved = !surface?.locating && (fallback || !target.startsWith('diff-view:') || (navigationBySession[sessionId]?.nonce === target.slice('diff-view:'.length) && (!surface?.selectionRevision || navigationBySession[sessionId]?.revision === surface.selectionRevision)));
  const showReview = Boolean(sessionId && targetResolved && (!error || retainReview) && (!selecting || readySession.current === sessionId));
  useEffect(() => {
    if (!surface?.key || surface.state !== 'ready' || !sessionId) { appliedSurface.current = undefined; return; }
    if (!showReview || error || selecting) return;
    const selected = navigationBySession[sessionId];
    if (surface.nonce && (selected?.nonce !== surface.nonce || selected.revision !== surface.selectionRevision)) return;
    if (appliedSurface.current !== surface.key) { appliedSurface.current = surface.key; wakeSurface.current?.(); }
  }, [surface?.key, sessionId, showReview, error, selecting, navigationBySession]);
  useEffect(() => {
    if (!sessionId || !showReview) return;
    setCachedSessions(previous => {
      const next = [sessionId, ...previous.filter(id => id !== sessionId)].slice(0, 6);
      return next;
    });
  }, [sessionId, showReview]);
  useEffect(() => {
    setNavigationBySession(values => Object.fromEntries(Object.entries(values).filter(([id]) => cachedSessions.includes(id))));
    resolvedSelection.current = Object.fromEntries(Object.entries(resolvedSelection.current).filter(([id]) => cachedSessions.includes(id)));
  }, [cachedSessions]);
  const emptyRequest: ReviewRequest = { scope: 'lastTurn', sessionId };
  return <div className="dv-panel dv-theme" data-base={appearance.base} data-surface="session">
    <div className="dv-panel-content">
      {surfaceError && <p className="dv-panel-message" role="alert">{surfaceError}</p>}
      {error && sessionId && (showReview || cachedSessions.includes(sessionId)) && <div className="dv-panel-message" role="alert">{error}<button onClick={() => setRetry(n => n + 1)}>重试</button><button onClick={() => { setFallback(true); setNavigationBySession(previous => { const next = { ...previous }; delete next[sessionId]; return next; }); setError(''); setSelecting(false); }}>返回本会话修改记录</button></div>}
      {cachedSessions.map(id => <div className="dv-panel-page" key={id} hidden={sessionId !== id}>
        <ReviewApp active={sessionId === id} transport={transport} initialRequest={navigationBySession[id]?.request ?? (id === sessionId ? emptyRequest : { scope: 'lastTurn', sessionId: id })} initialFileId={navigationBySession[id]?.fileId} autoSelectFile={navigationBySession[id]?.request.scope !== 'lastTurn'} navigationKey={navigationBySession[id] ? `${navigationBySession[id].nonce}:${navigationBySession[id].revision}` : `session:${id}`} {...appearance} />
      </div>)}
      {!showReview && !cachedSessions.includes(sessionId) ? selecting || error || surface?.locating ? <section className="dv-panel-message" role={error ? 'alert' : 'status'}>{error || '正在定位所选文件…'}{error && <><button onClick={() => { setFallback(false); setRetry(n => n + 1); }}>重试</button>{sessionId && <button onClick={() => { setFallback(true); setNavigationBySession(previous => { const next = { ...previous }; delete next[sessionId]; return next; }); setError(''); setSelecting(false); }}>返回本会话修改记录</button>}</>}</section> : !sessionId ? <section className="dv-panel-message" role="status">{connecting || surface?.state === 'waiting' ? '正在连接当前会话…' : '缺少会话身份，请从当前会话侧栏打开；历史记录不会回退到全局。'}</section> : null : null}
    </div>
  </div>;
}
const element = document.getElementById('root');
if (element) createRoot(element).render(<Panel />);
