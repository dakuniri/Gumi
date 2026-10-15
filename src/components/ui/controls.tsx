import { COLOR_LABELS, type GumiColor } from '../../hooks/useTheme';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import './controls.css';

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className={`field toggle-field ${disabled ? 'disabled' : ''}`}>
      <label htmlFor={id} className="field-label">
        {label}
        {hint && <span className="field-hint">{hint}</span>}
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        className={`switch ${checked ? 'on' : ''}`}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span className="knob" />
      </button>
    </div>
  );
}

export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <div className="field-label">
        {label}
        {hint && <span className="field-hint">{hint}</span>}
      </div>
      <div className="field-control">{children}</div>
    </div>
  );
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  ariaLabel?: string;
}) {
  return (
    <select className="input" value={value} aria-label={ariaLabel} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

const AUTO_SAVE_MS = 700;

/**
 * 入力の自動保存。
 * - 入力が止まって AUTO_SAVE_MS 経ったら保存
 * - フォーカスが外れたとき・Enter・ウィンドウを閉じるとき・画面を切り替えたときにも保存
 * 保存は onCommit (設定の更新) を呼ぶだけで、実際のファイル書き込みは Main Process が行う。
 */
export function useAutoSave(draft: string, save: (v: string) => void, enabled: boolean) {
  const latest = useRef({ draft, save, dirty: false });
  latest.current.draft = draft;
  latest.current.save = save;
  const timer = useRef<number | undefined>(undefined);

  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    if (!latest.current.dirty) return;
    latest.current.dirty = false;
    latest.current.save(latest.current.draft);
  }, []);

  const markDirty = useCallback(() => {
    latest.current.dirty = true;
    window.clearTimeout(timer.current);
    if (enabled) timer.current = window.setTimeout(flush, AUTO_SAVE_MS);
  }, [enabled, flush]);

  useEffect(() => {
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
      flush(); // タブ切り替えなどで入力欄が消えるときも保存
    };
  }, [flush]);

  return { markDirty, flush };
}

/** 入力すると自動で保存されるテキスト入力 (autoSave=false なら Enter / フォーカス移動時のみ) */
export function CommitInput({
  value,
  onCommit,
  placeholder,
  type = 'text',
  list,
  ariaLabel,
  autoSave = true,
}: {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  type?: 'text' | 'url' | 'password';
  list?: string;
  ariaLabel?: string;
  autoSave?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  // 入力中は保存結果の反映で文字が巻き戻らないよう、フォーカス中は外部の値で上書きしない
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);
  const valueRef = useRef(value);
  valueRef.current = value;
  const { markDirty, flush } = useAutoSave(
    draft,
    (v) => {
      if (v !== valueRef.current) onCommit(v);
    },
    autoSave,
  );
  return (
    <input
      className="input"
      type={type}
      value={draft}
      list={list}
      aria-label={ariaLabel}
      placeholder={placeholder}
      spellCheck={false}
      onFocus={() => {
        focused.current = true;
      }}
      onChange={(e) => {
        setDraft(e.target.value);
        markDirty();
      }}
      onBlur={() => {
        focused.current = false;
        flush();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') flush();
      }}
    />
  );
}

/** 入力すると自動で保存される数値入力。範囲外の値は確定時 (フォーカス移動 / Enter) に範囲内へ丸める */
export function NumberInput({
  value,
  min,
  max,
  step = 1,
  onCommit,
  ariaLabel,
  suffix,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onCommit: (v: number) => void;
  ariaLabel?: string;
  suffix?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(String(value));
  }, [value]);
  const valueRef = useRef(value);
  valueRef.current = value;
  const normalize = (n: number) => (step >= 1 ? Math.round(n) : n);
  // 入力途中 (例: 1500 を打つ途中の 1) で最小値に丸めないよう、自動保存は範囲内の値のときだけ行う
  const { markDirty, flush } = useAutoSave(
    draft,
    (d) => {
      const n = Number(d);
      if (d.trim() !== '' && Number.isFinite(n) && n >= min && n <= max && normalize(n) !== valueRef.current) {
        onCommit(normalize(n));
      }
    },
    true,
  );
  const commitClamped = () => {
    flush();
    const n = Number(draft);
    if (!Number.isFinite(n) || draft.trim() === '') {
      setDraft(String(valueRef.current));
      return;
    }
    const clamped = Math.min(max, Math.max(min, normalize(n)));
    setDraft(String(clamped));
    if (clamped !== valueRef.current) onCommit(clamped);
  };
  return (
    <span className="number-input">
      <input
        className="input"
        type="number"
        value={draft}
        min={min}
        max={max}
        step={step}
        aria-label={ariaLabel}
        onFocus={() => {
          focused.current = true;
        }}
        onChange={(e) => {
          setDraft(e.target.value);
          markDirty();
        }}
        onBlur={() => {
          focused.current = false;
          commitClamped();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commitClamped();
        }}
      />
      {suffix && <span className="suffix">{suffix}</span>}
    </span>
  );
}

/** 配色選択 (白 / 黒 / 亜夢) */
export function ColorChoice({ value, onChange }: { value: GumiColor; onChange: (v: GumiColor) => void }) {
  return (
    <div className="color-choice" role="radiogroup" aria-label="色">
      {(['white', 'black', 'amu'] as const).map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          className={`color-option ${c} ${value === c ? 'selected' : ''}`}
          onClick={() => onChange(c)}
        >
          <span className="color-dot" />
          {COLOR_LABELS[c]}
        </button>
      ))}
    </div>
  );
}

/** 亜夢のときの画面の色 (白 / 黒) */
export function ToneChoice({ value, onChange }: { value: 'white' | 'black'; onChange: (v: 'white' | 'black') => void }) {
  return (
    <div className="color-choice" role="radiogroup" aria-label="亜夢の画面の色">
      {(['white', 'black'] as const).map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          className={`color-option amu-tone ${c} ${value === c ? 'selected' : ''}`}
          onClick={() => onChange(c)}
        >
          <span className="color-dot" />
          {c === 'white' ? '白' : '黒'}
        </button>
      ))}
    </div>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'info' | 'warn' | 'danger' | 'ok'; children: ReactNode }) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}
