/**
 * 円の横の入力欄と、停止・一時停止ボタン。
 *
 *   入力中:  [停止] (      入力欄      )(円)     円から入力欄が伸び出る
 *   送信後:  入力欄は円に吸い込まれるように縮み、停止ボタンは円の上へ移動、一時停止ボタンが左に現れる
 *   作業後:  ボタンは円の中へ戻る
 *
 * 位置はすべて円の中心からの相対座標 (src/services/layout/controls.ts) で決め、
 * CSS のトランジションで動かす。クリックを受け付ける範囲は Main が同じ計算で判定している。
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { AgentStatus } from '../../types/agent';
import type { CharacterState } from '../../types/character';
import { BUTTON, GAP, PILL_HEIGHT, PILL_WIDTH, RESULT_MAX_HEIGHT, controlsLayout } from '../../services/layout/controls';
import { gumi } from '../../services/bridge';
import './orb-controls.css';

function StopIcon() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.6" fill="currentColor" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden>
      <rect x="3" y="2.5" width="3.6" height="11" rx="1" fill="currentColor" />
      <rect x="9.4" y="2.5" width="3.6" height="11" rx="1" fill="currentColor" />
    </svg>
  );
}

function ResumeIcon() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden>
      <path d="M4.5 2.6 L13 8 L4.5 13.4 Z" fill="currentColor" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * 作業後の結果 (AI のまとめ / 失敗の理由) を円の横に出す吹き出し。クリックで閉じる。
 * クリックを受け付ける範囲を Main に伝えるため、実際の高さを測って送る。
 */
function ResultNote({ size, ui }: { size: number; ui: CharacterState['ui'] }) {
  const ref = useRef<HTMLDivElement>(null);
  const result = ui.result;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !result) return;
    const send = () => gumi().send('character:result-size', { height: el.offsetHeight });
    send();
    const ro = new ResizeObserver(send);
    ro.observe(el);
    return () => ro.disconnect();
  }, [result]);
  if (!result || ui.mode !== 'idle') return null;
  return (
    <div
      ref={ref}
      className={`result-note ${result.kind}`}
      role="status"
      title="クリックで閉じる"
      style={{
        width: PILL_WIDTH,
        maxHeight: RESULT_MAX_HEIGHT,
        [ui.side === 'left' ? 'right' : 'left']: `calc(50% + ${size / 2 + GAP}px)`,
        [ui.controlsDir === 'up' ? 'bottom' : 'top']: `calc(50% - ${PILL_HEIGHT / 2}px)`,
      }}
      onClick={() => gumi().send('character:dismiss-result', {})}
    >
      <div className="result-head">{result.kind === 'success' ? '完了' : 'できませんでした'}</div>
      <div className="result-text">{result.text}</div>
    </div>
  );
}

function place(x: number, y: number, scale: number): CSSProperties {
  return { transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px)) scale(${scale})` };
}

export function OrbControls({ size, ui, agent }: { size: number; ui: CharacterState['ui']; agent: AgentStatus }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const textRef = useRef(text);
  textRef.current = text;
  const l = controlsLayout(size, ui.side, ui.controlsDir);
  const mode = ui.mode;
  const paused = agent.phase === 'paused';
  /** 入力欄の位置に出すもの: 指示の入力 / 承認 / AI への回答 */
  const content: 'input' | 'approval' | 'question' | null =
    mode === 'input' ? 'input' : mode === 'task' && ui.prompt ? ui.prompt : null;
  const approval = agent.pendingApproval;
  const question = agent.pendingQuestion;

  // 入力欄が開いたら / 質問が来たらフォーカス
  useEffect(() => {
    if (content !== 'input' && content !== 'question') return;
    setError(null);
    setText('');
    const t = window.setTimeout(() => inputRef.current?.focus(), 60);
    return () => window.clearTimeout(t);
  }, [content, question?.id]);

  // 何も入力せずに別の場所をクリックしたら閉じる
  useEffect(() => {
    const onBlur = () => {
      if (mode === 'input' && !textRef.current.trim()) gumi().send('character:close-input', {});
    };
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, [mode]);

  const submit = async () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    setError(null);
    try {
      if (content === 'question' && question) await gumi().invoke('agent:answer', { id: question.id, text: t });
      else await gumi().invoke('agent:start', { text: t });
      setText('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  const onStop = () => {
    if (mode === 'task') void gumi().invoke('agent:stop').catch(() => undefined);
    else gumi().send('character:close-input', {});
  };

  const respond = (approved: boolean) => {
    if (!approval) return;
    void gumi()
      .invoke('agent:approve', { id: approval.id, approved, remember: false })
      .catch((err: Error) => setError(err.message));
  };

  const onPause = () => {
    void gumi()
      .invoke(paused ? 'agent:resume' : 'agent:pause')
      .catch(() => undefined);
  };

  // ---- 入力欄: 円の中心から伸び出る (円の下に重ねて描き、円側の端は円に隠れる) ----
  const reach = size / 2 + GAP + PILL_WIDTH;
  const pillStyle: CSSProperties = {
    height: PILL_HEIGHT,
    width: content ? reach : 0,
    [ui.side === 'left' ? 'right' : 'left']: '50%',
    paddingLeft: ui.side === 'left' ? 14 : size / 2 + GAP + 4,
    paddingRight: ui.side === 'left' ? size / 2 + GAP + 4 : 14,
  };

  // ---- ボタンの位置 ----
  const stopPos =
    mode === 'input' ? place(l.inputStop.x, l.inputStop.y, 1) : mode === 'task' ? place(l.taskStop.x, l.taskStop.y, 1) : place(0, 0, 0.2);
  const pausePos = mode === 'task' ? place(l.taskPause.x, l.taskPause.y, 1) : place(0, 0, 0.2);

  return (
    <>
      <ResultNote size={size} ui={ui} />
      <div className={`pill side-${ui.side} ${content ? 'open' : ''} ${error ? 'has-error' : ''}`} style={pillStyle}>
        {content === 'approval' && approval ? (
          <div className="pill-approval" title={`${approval.description}\n${approval.reason}${approval.details ? `\n\n${approval.details}` : ''}`}>
            <span className="pill-text">許可しますか？</span>
            <button type="button" className="pill-btn" onClick={() => respond(false)}>
              拒否
            </button>
            <button type="button" className="pill-btn primary" onClick={() => respond(true)}>
              許可
            </button>
          </div>
        ) : (
          <input
            ref={inputRef}
            className="pill-input"
            value={text}
            maxLength={8000}
            disabled={sending || !content}
            tabIndex={content ? 0 : -1}
            placeholder={content === 'question' ? '回答を入力 (Enter で送信)' : 'やってほしいことを入力 (Enter で実行)'}
            aria-label={content === 'question' ? 'Gumi への回答' : 'Gumi への指示'}
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit();
              } else if (e.key === 'Escape' && content === 'input') {
                gumi().send('character:close-input', {});
              }
            }}
          />
        )}
      </div>
      {/* AI からの質問 / 承認する操作の内容は、入力欄の上 (作業中ボタンと同じ側、画面内に余白がある側) に小さく出す */}
      {((content === 'question' && question) || (content === 'approval' && approval)) && (
        <div
          className={`pill-note side-${ui.side}`}
          style={{
            // 作業中ボタン (円の上) と重ならないよう、ボタンより外側から始める
            [ui.side === 'left' ? 'right' : 'left']: `calc(50% + ${size / 2 + GAP + BUTTON}px)`,
            [ui.controlsDir === 'up' ? 'bottom' : 'top']: `calc(50% + ${PILL_HEIGHT / 2 + 6}px)`,
          }}
        >
          {content === 'question'
            ? question?.question
            : `${approval?.risk === 'high' ? '注意: ' : ''}${approval?.description ?? ''} (${approval?.reason ?? ''})`}
        </div>
      )}
      {error && content && (
        <div
          className={`pill-error side-${ui.side}`}
          style={{
            [ui.side === 'left' ? 'right' : 'left']: `calc(50% + ${size / 2 + GAP}px)`,
            [ui.controlsDir === 'up' ? 'bottom' : 'top']: `calc(50% + ${PILL_HEIGHT / 2 + 6}px)`,
          }}
          role="alert"
        >
          {error}
        </div>
      )}
      <button
        type="button"
        className={`ctrl ctrl-stop ${mode === 'idle' ? 'hidden' : ''}`}
        style={{ width: BUTTON, height: BUTTON, ...stopPos }}
        title={mode === 'task' ? '停止 (押されたままのキー・ボタンも解放します)' : '入力をやめる'}
        aria-label={mode === 'task' ? '停止' : '入力をやめる'}
        tabIndex={mode === 'idle' ? -1 : 0}
        onClick={onStop}
      >
        <StopIcon />
      </button>
      <button
        type="button"
        className={`ctrl ctrl-pause ${mode === 'task' ? '' : 'hidden'} ${paused ? 'paused' : ''}`}
        style={{ width: BUTTON, height: BUTTON, ...pausePos }}
        title={paused ? '再開' : '一時停止'}
        aria-label={paused ? '再開' : '一時停止'}
        tabIndex={mode === 'task' ? 0 : -1}
        onClick={onPause}
      >
        {paused ? <ResumeIcon /> : <PauseIcon />}
      </button>
    </>
  );
}
