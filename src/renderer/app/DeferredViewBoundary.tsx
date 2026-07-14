import { AlertTriangle, ArrowLeft, RotateCcw } from "lucide-react";
import { Component, Fragment } from "react";
import type { ErrorInfo, ReactNode } from "react";

interface DeferredViewBoundaryProps {
  children: ReactNode;
  resetKey: string;
  title: string;
  onBack: () => void;
}

interface DeferredViewBoundaryState {
  hasError: boolean;
  retrySequence: number;
}

export class DeferredViewBoundary extends Component<
  DeferredViewBoundaryProps,
  DeferredViewBoundaryState
> {
  public state: DeferredViewBoundaryState = {
    hasError: false,
    retrySequence: 0
  };

  public static getDerivedStateFromError(): Partial<DeferredViewBoundaryState> {
    return { hasError: true };
  }

  public componentDidCatch(error: Error, _errorInfo: ErrorInfo): void {
    console.error(`Deferred view failed to render: ${error.name}`);
  }

  public componentDidUpdate(previousProps: DeferredViewBoundaryProps): void {
    if (previousProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  private retry = (): void => {
    this.setState((state) => ({
      hasError: false,
      retrySequence: state.retrySequence + 1
    }));
  };

  public render(): ReactNode {
    if (this.state.hasError) {
      return (
        <section
          className="stagePane selectorGuideStage deferredViewFallback deferredViewError"
          role="alert"
          aria-live="assertive"
        >
          <div className="selectorGuideVisual" aria-hidden="true">
            <span className="selectorGuideScreen">
              <AlertTriangle size={28} />
            </span>
          </div>
          <div className="selectorGuideCopy">
            <h2>{this.props.title}</h2>
            <p>当前页面遇到异常，配置和本地资源没有被修改。你可以返回主页或重试。</p>
          </div>
          <div className="selectorGuideActions">
            <button className="secondaryAction" type="button" onClick={this.props.onBack}>
              <ArrowLeft size={17} />
              返回主页
            </button>
            <button className="primaryAction" type="button" onClick={this.retry}>
              <RotateCcw size={17} />
              重试
            </button>
          </div>
        </section>
      );
    }

    return <Fragment key={this.state.retrySequence}>{this.props.children}</Fragment>;
  }
}
