import { useLayoutEffect, useRef } from 'react';
import { Keyboard, RotateCcw, Trash2, X } from 'lucide-react';
import type { Comment } from '../../../../packages/core/types';
import { time } from '../format';
import './WorkspaceDialogs.css';

function useModal(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => { if (open && !ref.current?.open) ref.current?.showModal(); else if (!open && ref.current?.open) ref.current.close(); }, [open]);
  return ref;
}

const shortcuts = [
  ['영상과 시간', [['Space / K', '재생 / 일시 정지'], ['← / →', '이전 / 다음 프레임'], ['Shift + ← / →', '1초 이동'], ['J / L', '이전 / 다음 5초 (그림 도구에 포커스가 없을 때)'], ['Home / End', '첫 / 마지막 프레임'], ['G', '시간 직접 입력 · 분:초 또는 초'], ['[ / ]', '보기 배속 낮추기 / 높이기 (0.25–4×)'], ['M', '보기용 음소거'], ['I / O', '구간 시작 / 끝 지정'], ['C', '현재 시점에 작성 · 작성 중인 초안으로 복귀'], ['B', '검수 마커 찍기 / 지우기 (그림 도구에 포커스가 없을 때)'], [', / .', '이전 / 다음 검수 마커로 이동']]],
  ['영상 확대와 보기', [['+ / −', '영상 확대 / 축소 (최대 400%)'], ['0', '화면 맞춤 · 이동 위치 초기화'], ['Ctrl / ⌘ + 휠', '마우스 위치를 중심으로 확대 / 축소'], ['H → 드래그', '확대한 영상 이동 · 다시 H로 그림 조작'], ['가운데 버튼 드래그', '확대한 영상 임시 이동'], ['F / Esc', '전체 화면 / 전체 화면 종료']]],
  ['시간 눈금 선택 시', [['클릭 / 드래그', '시간 눈금·마커 빈 공간·장면에서 이동'], ['Home / End', '첫 / 마지막 프레임'], ['PageUp / PageDown', '이전 / 다음 5초'], ['Esc', '진행 중인 탐색 종료']]],
  ['피드백', [['⌘ / Ctrl + Enter', '작성 중인 피드백·수정·추가 지시 저장'], ['F2', '선택한 피드백 수정'], ['Alt + ↑ / ↓', '목록에서 이전 / 다음 피드백'], ['Shift + Delete', '선택한 피드백을 휴지통으로 이동'], ['Esc', '수정 취소 · 미리보기 닫기']]],
  ['그림 영역', [['V / B / E', '선택 / 박스 / 원'], ['Esc', '선택 도구로 전환 · 진행 중인 그리기 취소'], ['L / A / P', '선 / 화살표 / 펜'], ['T', '텍스트 연속 입력'], ['도구 다시 클릭', '색상·굵기·채움 팝업'], ['텍스트 두 번 클릭', '내용 수정'], ['⌘ / Ctrl + D', '선택한 그림 복제'], ['스타일 팝업 → 맨 앞 / 뒤', '현재 장면의 그림 겹침 순서 변경'], ['← ↑ ↓ →', '선택한 그림 1px 이동 (Shift: 10px)'], ['Delete / Backspace', '선택한 그림 삭제'], ['⌘ / Ctrl + Z', '그림 되돌리기'], ['⌘ / Ctrl + Shift + Z', '그림 다시 실행']]],
  ['첨부 이미지 미리보기', [['← / →', '이전 / 다음 이미지'], ['Esc', '이미지 닫기']]],
  ['패널 경계 선택 시', [['← / →', '패널 경계 10px 이동'], ['Shift + ← / →', '패널 경계 40px 이동'], ['Home / End', '최소 / 최대 너비'], ['Enter / 더블클릭', '기본 너비 복원'], ['Esc', '진행 중인 너비 조절 취소']]],
  ['영상·타임라인 경계 선택 시', [['↑ / ↓', '타임라인 높이 10px 조절'], ['Shift + ↑ / ↓', '타임라인 높이 40px 조절'], ['Home / End', '최소 / 최대 높이'], ['Enter / 더블클릭', '기본 높이 복원'], ['Esc', '진행 중인 높이 조절 취소']]],
] as const;

export function ShortcutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useModal(open);
  return <dialog ref={dialog} className="workspace-dialog shortcuts-dialog" aria-labelledby="shortcuts-title" onCancel={event => { event.preventDefault(); onClose(); }} onClose={onClose} onKeyDown={event => event.stopPropagation()}>
    <header><h2 id="shortcuts-title"><Keyboard size={19}/>단축키</h2><button autoFocus className="quiet" aria-label="단축키 닫기" onClick={onClose}><X size={20}/></button></header>
    <p className="workspace-dialog-intro">문자를 입력할 때는 영상·그림 단축키가 작동하지 않습니다. 모든 그리기 도구는 연속 모드입니다. V로 선택 도구에 돌아옵니다. 그림 이동·삭제는 그림 영역을 선택한 뒤 사용하세요.</p>
    <div className="shortcut-groups">{shortcuts.map(([title, rows]) => <section key={title}><h3>{title}</h3><dl>{rows.map(([keys, label]) => <div key={keys}><dt>{label}</dt><dd><kbd>{keys}</kbd></dd></div>)}</dl></section>)}</div>
    <footer><span><kbd>?</kbd> 또는 <kbd>⌘ / Ctrl + /</kbd>로 열기</span><button className="secondary" onClick={onClose}>닫기</button></footer>
  </dialog>;
}

export function FeedbackTrashDialog({ open, comments, busy, onClose, onRestore }: { open: boolean; comments: Comment[]; busy: boolean; onClose: () => void; onRestore: (id: string) => Promise<boolean> }) {
  const dialog = useModal(open);
  return <dialog ref={dialog} className="workspace-dialog trash-dialog" aria-labelledby="trash-title" onCancel={event => { event.preventDefault(); onClose(); }} onClose={onClose} onKeyDown={event => event.stopPropagation()}>
    <header><h2 id="trash-title"><Trash2 size={19}/>피드백 휴지통 <span>{comments.length}</span></h2><button className="quiet" autoFocus aria-label="휴지통 닫기" onClick={onClose}><X size={20}/></button></header>
    <p className="workspace-dialog-intro">삭제한 피드백은 전달 자료에서 제외됩니다. 장면·그림·첨부와 함께 복구할 수 있습니다.</p>
    <div className="trash-items">{comments.length ? [...comments].reverse().map(comment => <article key={comment.id}><div><time>{time(comment.frameIn)}{comment.frameOut - comment.frameIn > 1 ? ` – ${time(comment.frameOut)}` : ''}</time><p>{comment.text || comment.sceneDescription || '그림·첨부 피드백'}</p><small>그림 {comment.drawings.length}개 · 첨부 {new Set([...comment.attachmentIds, ...(comment.voiceAssetId ? [comment.voiceAssetId] : [])]).size}개</small></div><button className="secondary" disabled={busy} onClick={() => void onRestore(comment.id)}><RotateCcw size={14}/>복구</button></article>) : <div className="trash-empty"><Trash2 size={27}/><p>삭제한 피드백이 없습니다.</p></div>}</div>
    <footer><span>복구한 요청은 필요한 경우 다시 해석·승인하세요.</span><button className="secondary" onClick={onClose}>닫기</button></footer>
  </dialog>;
}
