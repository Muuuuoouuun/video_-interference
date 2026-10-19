import type { FeedbackCategory } from '../../../../packages/core/types';
import { FEEDBACK_CATEGORIES, FEEDBACK_CATEGORY_LABELS } from '../../../../packages/core/feedback-category.mjs';
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
