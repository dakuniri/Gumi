import { useEffect, useRef, useState } from 'react';
import { useApp } from './useApp';
import { REACTION_DURATION_MS, reactionForPhase, resolveExpression } from '../services/expressions/resolver';
import type { ExpressionName, ReactionKind } from '../types/character';
import type { AgentStatus } from '../types/agent';

function isErrorOutcome(agent: AgentStatus): boolean {
  return /^(AI API エラー|予期しないエラー)/.test(agent.summary ?? '');
}

/**
 * 円の現在の状態表現を決定するフック。
 * 実際の決定は純粋関数 resolveExpression に一元化されており、ここでは入力を集めるだけ。
 */
export function useExpression(): { expression: ExpressionName; reaction: ReactionKind | null } {
  const agent = useApp((s) => s.agent);
  const character = useApp((s) => s.character);
  const [reaction, setReaction] = useState<ReactionKind | null>(null);
  const prevPhase = useRef(agent.phase);
  const reactionTimer = useRef<number | null>(null);

  useEffect(() => {
    const r = reactionForPhase(prevPhase.current, agent.phase, isErrorOutcome(agent));
    prevPhase.current = agent.phase;
    if (agent.phase === 'thinking' || agent.phase === 'acting') {
      setReaction(null);
      return;
    }
    if (!r) return;
    setReaction(r);
    if (reactionTimer.current) window.clearTimeout(reactionTimer.current);
    reactionTimer.current = window.setTimeout(() => setReaction(null), REACTION_DURATION_MS[r]);
  }, [agent.phase, agent]);

  useEffect(
    () => () => {
      if (reactionTimer.current) window.clearTimeout(reactionTimer.current);
    },
    [],
  );

  const expression = resolveExpression({
    phase: agent.phase,
    pendingApproval: !!agent.pendingApproval,
    pendingQuestion: !!agent.pendingQuestion,
    sleeping: !!character?.sleeping,
    waking: !!character?.waking,
    hover: !!character?.hover,
    dragging: !!character?.dragging,
    inputOpen: character?.ui.mode === 'input',
    idle: !!character?.idle,
    reaction,
  });
  return { expression, reaction };
}
