import type { FeedbackCategory } from '../../../../packages/core/types';
import { FEEDBACK_CATEGORIES, FEEDBACK_CATEGORY_LABELS } from '../../../../packages/core/feedback-category.mjs';
import { Blend, Captions, Film, StickyNote, Volume2 } from 'lucide-react';
import './FeedbackCategory.css';

export function FeedbackCategorySelect({ value, onChange, disabled, includeNote = false, label = '피드백 분야' }: {
  value: FeedbackCategory | 'note'; onChange: (value: FeedbackCategory | 'note') => void;
  disabled?: boolean; includeNote?: boolean; label?: string;
}) {
  return <label className="feedback-category-select" data-feedback-category={value}>
    <span className="feedback-category-dot" aria-hidden="true"/>
    <select aria-label={label} value={value} disabled={disabled} onChange={event => onChange(event.target.value as FeedbackCategory | 'note')}>
      {FEEDBACK_CATEGORIES.map(category => <option key={category} value={category}>{FEEDBACK_CATEGORY_LABELS[category]}</option>)}
      {includeNote ? <option value="note">메모</option> : null}
    </select>
  </label>;
}

const CHIP_VALUES: (FeedbackCategory | 'note')[] = [...FEEDBACK_CATEGORIES, 'note'];
const CHIP_ICONS = { video: Film, subtitle: Captions, audio: Volume2, effect: Blend, note: StickyNote } as const;

/**
 * One-click category choice for the composer. "메모" stores a note instead of feedback.
 * Every chip keeps its text as the accessible name; only the chosen one shows it, so the row stays on one line.
 */
export function FeedbackCategoryChips({ value, onChange, disabled, label = '피드백 분야' }: {
  value: FeedbackCategory | 'note'; onChange: (value: FeedbackCategory | 'note') => void; disabled?: boolean; label?: string;
}) {
  return <div className="feedback-category-chips" role="radiogroup" aria-label={label}>
    {CHIP_VALUES.map(option => { const Icon = CHIP_ICONS[option]; return <button key={option} type="button" role="radio" aria-checked={value === option} className="feedback-category-chip" data-feedback-category={option} disabled={disabled} title={FEEDBACK_CATEGORY_LABELS[option]} onClick={() => onChange(option)}>
      <Icon size={14} aria-hidden="true"/><span className="feedback-category-chip-label">{FEEDBACK_CATEGORY_LABELS[option]}</span>
    </button>; })}
  </div>;
}
