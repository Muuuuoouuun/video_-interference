import type { Comment, Drawing } from '../../../../packages/core/types';
import type { CommentProjection } from '../../../../packages/core/comment-projection.mjs';
import { time } from '../format';

interface Props {
  comment: Comment;
  projection: CommentProjection | null;
  drawingGroups: { frame: number; drawings: Drawing[] }[];
  deletedDrawingCount: number;
  unavailableDrawingCount: number;
  currentVersionNumber: number;
  selectedRangeIndex: number;
  hasDraft: boolean;
  hasDrawingHistory?: boolean;
  busy: boolean;
  onRangeSelect: (index: number) => void;
  onCompose: (copyDrawings?: boolean, drawingFrame?: number) => void;
}

export function SavedRequestContext({ comment, projection, drawingGroups, deletedDrawingCount, unavailableDrawingCount, currentVersionNumber, selectedRangeIndex, hasDraft, hasDrawingHistory = false, busy, onRangeSelect, onCompose }: Props) {
  const canReturn = hasDraft || hasDrawingHistory;
  const hasRange = Boolean(projection?.ranges.length);
  const selectedRange = projection?.ranges[selectedRangeIndex];
  return <div className="saved-request-context">
    <strong>저장된 {comment.kind === 'note' ? '메모' : '피드백'} · v{currentVersionNumber}에서 확인</strong>
    {canReturn ? <p>{hasDraft ? '작성 중인 장면 내용·피드백은 그대로 보관되어 있습니다.' : '그림은 모두 지웠지만 되돌리기·다시 실행 기록은 남아 있습니다.'}</p> : !hasRange ? <p>{projection?.status === 'deleted' ? '이 피드백의 구간은 현재 버전에서 삭제됐습니다.' : '현재 버전에서 표시할 구간을 확인할 수 없습니다.'} 카드의 작성 버전에서 원래 장면을 확인하세요.</p> : <p>{projection?.status === 'partial' ? '현재 버전에 표시할 수 있는 일부 구간만 보입니다. ' : ''}위 카드의 수정 버튼으로 내용을 고치거나, 추가 지시를 덧붙일 수 있습니다.</p>}
    {projection && projection.ranges.length > 1 ? <div className="request-range-options" role="group" aria-label="현재 버전의 피드백 구간 선택">{projection.ranges.map((range, index) => <button key={`${range.frameIn}-${range.frameOut}`} className="quiet" aria-pressed={selectedRangeIndex === index} disabled={busy} onClick={() => onRangeSelect(index)}>구간 {index + 1} · {time(range.frameIn)}–{time(range.frameOut)}</button>)}</div> : null}
    {deletedDrawingCount > 0 || unavailableDrawingCount > 0 ? <p className="request-anchor-missing">{deletedDrawingCount > 0 ? `그림 ${deletedDrawingCount}개의 장면이 삭제됐습니다. ` : ''}{unavailableDrawingCount > 0 ? `그림 ${unavailableDrawingCount}개의 위치를 확인할 수 없습니다. ` : ''}해당 그림은 작성 버전에서 확인하세요.</p> : null}
    <div>
      <button className="outline-mint" disabled={busy || (!canReturn && !hasRange)} onClick={() => onCompose()}>{canReturn ? '초안으로 돌아가기' : projection && projection.ranges.length > 1 ? '선택한 구간에 새 피드백' : '이 구간에 새 피드백'}</button>
    </div>
    {!hasDraft && drawingGroups.length > 0 ? <div className="request-drawing-copies" role="group" aria-label="장면별 그림을 새 피드백에 복사"><p>복사할 장면을 선택하세요. 선택한 그림의 기준 프레임을 유지합니다.</p>{drawingGroups.map(group => <button key={group.frame} className="quiet" disabled={busy || !hasRange} onClick={() => onCompose(true, group.frame)}>{time(group.frame)} · 그림 {group.drawings.length}개 복사{selectedRange && (group.frame < selectedRange.frameIn || group.frame >= selectedRange.frameOut) ? ' · 구간 밖 참고' : ''}</button>)}</div> : null}
  </div>;
}
