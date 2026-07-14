import {
  BookOpen,
  CircleAlert,
  Clock3,
  MessageSquareQuote,
  RefreshCw,
  Sparkles,
  UserRound
} from "lucide-react";
import type { MemorySourceConversation } from "../../../shared/types/memory";
import { formatMemoryDateTime } from "./memoryBookState";

interface MemorySourcePanelProps {
  petName: string;
  source?: MemorySourceConversation;
  loading: boolean;
  error?: string;
  memoryWasEdited: boolean;
  onRetry: () => void;
  onBack: () => void;
}

export function MemorySourcePanel({
  petName,
  source,
  loading,
  error,
  memoryWasEdited,
  onRetry,
  onBack
}: MemorySourcePanelProps): JSX.Element {
  return (
    <div className="memorySourcePanel">
      <div className="memorySourceIntro">
        <MessageSquareQuote size={20} aria-hidden="true" />
        <p>仅展示生成这条记忆所依据的一轮对话。</p>
      </div>

      {loading ? (
        <div className="memorySourceState" role="status">
          <BookOpen size={25} aria-hidden="true" />
          <span>正在读取来源对话…</span>
        </div>
      ) : null}

      {!loading && error ? (
        <div className="memorySourceState error" role="alert">
          <CircleAlert size={24} aria-hidden="true" />
          <strong>来源对话暂时无法读取</strong>
          <span>{error}</span>
          <button className="secondaryAction" type="button" onClick={onRetry}>
            <RefreshCw size={16} aria-hidden="true" />重试
          </button>
        </div>
      ) : null}

      {!loading && source ? (
        <>
          <dl className="memorySourceMeta">
            <div>
              <dt><Clock3 size={15} aria-hidden="true" />对话时间</dt>
              <dd>{formatMemoryDateTime(source.occurredAt)}</dd>
            </div>
            <div>
              <dt><Sparkles size={15} aria-hidden="true" />整理时间</dt>
              <dd>{formatMemoryDateTime(source.organizedAt)}</dd>
            </div>
          </dl>

          <div className="memorySourceTurns" aria-label="生成这条记忆的一轮对话">
            <article className="memorySourceTurn user" aria-label="你当时说">
              <header><UserRound size={17} aria-hidden="true" /><span>你</span></header>
              <div className="memorySourceBubble"><p>{source.userText}</p></div>
            </article>
            <article className="memorySourceTurn pet" aria-label={`${petName} 当时回复`}>
              <header><Sparkles size={17} aria-hidden="true" /><span>{petName}</span></header>
              <div className="memorySourceBubble"><p>{source.assistantReply}</p></div>
            </article>
          </div>

          {memoryWasEdited ? (
            <p className="memorySourceRevisionNote">
              <CircleAlert size={16} aria-hidden="true" />
              这条记忆后来经过编辑；来源仅供追溯，不随记忆内容修改。
            </p>
          ) : null}
        </>
      ) : null}

      <div className="memoryDialogActions">
        <button className="secondaryAction" type="button" onClick={onBack}>返回记忆详情</button>
      </div>
    </div>
  );
}
