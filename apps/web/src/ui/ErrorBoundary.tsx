import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props { children: ReactNode }
interface State { error: Error | null }

/**
 * Keeps a render error from leaving a blank page. Saved feedback lives on the local worker and typed
 * composer text is kept in this browser, so reloading is safe; the message says so.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: Error): State { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('화면을 그리는 중 오류가 발생했습니다.', error, info.componentStack); }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return <div className="app-crash" role="alert">
      <section>
        <h1>화면을 표시하지 못했습니다</h1>
        <p>저장한 피드백은 이 PC에 그대로 있습니다. 작성 중이던 글은 다시 열면 복구할 수 있습니다. 그림·첨부처럼 저장하지 않은 자료는 다시 추가해야 할 수 있습니다.</p>
        <pre>{error.message || String(error)}</pre>
        <button className="primary" onClick={() => window.location.reload()}>다시 불러오기</button>
      </section>
    </div>;
  }
}
