export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Main Process が管理する円 (Gumi) の状態 (表示の決定に使う) */
export interface CharacterState {
  sleeping: boolean;
  waking: boolean;
  hover: boolean;
  dragging: boolean;
  /** 最後のユーザー操作 (Gumi への操作) からの経過が長いか */
  idle: boolean;
  /** 円の矩形 (DIP, スクリーン座標) */
  faceRect: Rect;
  /** ホバー時に出る 2 つの小さな円 (設定 / 色変更) */
  bubbles: { open: boolean; direction: 'up' | 'down' };
  /** 入力欄・作業中ボタンの表示状態 */
  ui: {
    mode: 'idle' | 'input' | 'task';
    /** 承認待ち / 質問待ちのとき入力欄の位置に出す内容 */
    prompt: 'approval' | 'question' | null;
    /** 作業後に円の横に出す結果 (AI のまとめ / 失敗の理由)。クリックで閉じる */
    result: { kind: 'success' | 'error'; text: string } | null;
    side: 'left' | 'right';
    controlsDir: 'up' | 'down';
  };
  /** 円が置かれている画面上の位置 (象限) */
  quadrant: { vertical: 'top' | 'bottom'; horizontal: 'left' | 'right' };
}

export type ExpressionName =
  | 'normal'
  | 'idle'
  | 'thinking'
  | 'searching'
  | 'working'
  | 'success'
  | 'failure'
  | 'error'
  | 'waiting'
  | 'sleep'
  | 'waking'
  | 'hover'
  | 'drag';

export type ReactionKind = 'success' | 'failure' | 'error';
