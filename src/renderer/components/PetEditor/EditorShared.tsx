import { AlertTriangle, Check, CheckCircle2, ChevronDown, FolderInput, Save, XCircle } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties } from "react";
import type { LocalPetSaveResult } from "../../../shared/types/pet";

type SaveFeedbackResult = Pick<LocalPetSaveResult, "ok" | "message">;

interface AppleSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export function AppleSelect({
  value,
  options,
  onChange,
  disabled = false,
  placeholder = "请选择",
  ariaLabel,
  className,
  menuBoundarySelector
}: {
  value: string;
  options: AppleSelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
  menuBoundarySelector?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [menuMaxHeight, setMenuMaxHeight] = useState<number | undefined>();
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selectedOption = options.find((option) => option.value === value);
  const selectLabel = selectedOption?.label ?? placeholder;

  useEffect(() => {
    if (!open) {
      return;
    }

    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    window.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("keydown", closeOnEscape);

    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !menuBoundarySelector) {
      setMenuMaxHeight(undefined);
      return;
    }

    const updateMenuMaxHeight = (): void => {
      const root = rootRef.current;
      const menu = menuRef.current;
      const boundary = root?.closest(menuBoundarySelector);

      if (!root || !menu || !boundary) {
        setMenuMaxHeight(undefined);
        return;
      }

      const menuTop = menu.getBoundingClientRect().top;
      const boundaryBottom = boundary.getBoundingClientRect().bottom;
      const nextMaxHeight = Math.floor(boundaryBottom - menuTop - 8);

      setMenuMaxHeight(nextMaxHeight > 96 ? nextMaxHeight : 96);
    };

    updateMenuMaxHeight();
    window.addEventListener("resize", updateMenuMaxHeight);
    window.addEventListener("scroll", updateMenuMaxHeight, true);

    return () => {
      window.removeEventListener("resize", updateMenuMaxHeight);
      window.removeEventListener("scroll", updateMenuMaxHeight, true);
    };
  }, [menuBoundarySelector, open]);

  const selectClassName = [
    "appleSelect",
    open ? "open" : "",
    className ?? ""
  ].filter(Boolean).join(" ");
  const menuStyle = menuMaxHeight
    ? ({
        "--apple-select-menu-max-height": `${menuMaxHeight}px`
      } as CSSProperties)
    : undefined;

  return (
    <div className={selectClassName} ref={rootRef}>
      <button
        className="appleSelectButton"
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        onClick={() => setOpen((currentOpen) => !currentOpen)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className={selectedOption ? "appleSelectValue" : "appleSelectValue placeholder"}>
          {selectLabel}
        </span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>

      {open && !disabled ? (
        <div
          className="appleSelectMenu"
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          ref={menuRef}
          style={menuStyle}
        >
          {options.map((option) => {
            const selected = option.value === value;

            return (
              <button
                className={selected ? "appleSelectOption selected" : "appleSelectOption"}
                type="button"
                role="option"
                aria-selected={selected}
                disabled={option.disabled}
                key={option.value}
                onClick={() => {
                  if (option.disabled) {
                    return;
                  }

                  onChange(option.value);
                  setOpen(false);
                }}
              >
                <span>{option.label}</span>
                {selected ? <Check size={15} aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function UnsavedChangesDialog({
  onCancel,
  onConfirm
}: {
  onCancel: () => void;
  onConfirm: () => void;
}): JSX.Element {
  return (
    <div className="unsavedOverlay" role="dialog" aria-modal="true" aria-label="未保存修改">
      <div className="unsavedDialog">
        <span className="unsavedIcon" aria-hidden="true">
          <AlertTriangle size={22} />
        </span>
        <div className="unsavedText">
          <h2>当前页面还有修改没保存</h2>
          <p>切换到其他栏目后，这些尚未保存的内容可能会丢失。确定要离开吗？</p>
        </div>
        <div className="unsavedActions">
          <button className="secondaryAction" type="button" onClick={onCancel}>
            留在这里
          </button>
          <button className="primaryAction danger" type="button" onClick={onConfirm}>
            仍然离开
          </button>
        </div>
      </div>
    </div>
  );
}

export function SaveSuccessToast({
  result,
  title = "保存成功",
  message
}: {
  result?: SaveFeedbackResult;
  title?: string;
  message?: string;
}): JSX.Element | null {
  const [toast, setToast] = useState<{ id: number; title: string; message: string } | undefined>();
  const dismissTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (result?.ok) {
      if (dismissTimerRef.current) {
        window.clearTimeout(dismissTimerRef.current);
      }

      dismissTimerRef.current = window.setTimeout(() => {
        setToast(undefined);
        dismissTimerRef.current = undefined;
      }, 1400);

      setToast((currentToast) => ({
        id: (currentToast?.id ?? 0) + 1,
        title,
        message: message ?? result.message ?? "修改已保存。"
      }));
    }

    if (result && !result.ok) {
      if (dismissTimerRef.current) {
        window.clearTimeout(dismissTimerRef.current);
        dismissTimerRef.current = undefined;
      }

      setToast(undefined);
    }
  }, [message, result, title]);

  useEffect(() => {
    return () => {
      if (dismissTimerRef.current) {
        window.clearTimeout(dismissTimerRef.current);
      }
    };
  }, []);

  const popupHost = document.getElementById("editor-canvas-overlay");

  if (!toast || !popupHost) {
    return null;
  }

  return createPortal(
    <div className="voiceConnectPopup voiceFeedbackPopup success" role="status" aria-live="polite" key={toast.id}>
      <span className="voiceFeedbackIcon" aria-hidden="true">
        <CheckCircle2 size={22} />
      </span>
      <strong>{toast.title}</strong>
      <p>{toast.message}</p>
    </div>,
    popupHost
  );
}

export function PanelSaveActions({
  onSave,
  saving = false,
  disabled = false,
  disabledReason,
  result,
  saved = false
}: {
  onSave?: () => void;
  saving?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  result?: SaveFeedbackResult;
  saved?: boolean;
}): JSX.Element {
  return (
    <div className="panelSaveActions">
      <SaveSuccessToast result={result} />
      {disabled && disabledReason ? <span className="saveDisabledHint">{disabledReason}</span> : null}
      {result && !result.ok ? (
        <div className="settingsResult error compactResult">
          <XCircle size={16} />
          <span>{result.message}</span>
        </div>
      ) : null}
      <button className="primaryAction" type="button" disabled={saving || disabled} onClick={onSave}>
        {saved && !saving ? <CheckCircle2 size={17} /> : <Save size={17} />}
        {saving ? "保存中" : saved ? "已保存" : "保存"}
      </button>
    </div>
  );
}

export function VoiceFileRow({
  icon,
  title,
  fileName,
  hint,
  onPick
}: {
  icon: JSX.Element;
  title: string;
  fileName?: string;
  hint: string;
  onPick: () => void;
}): JSX.Element {
  const displayName = fileName ? fileName.split(/[\\/]/).at(-1) ?? fileName : "未选择";

  return (
    <div className="voiceFileRow">
      <span className="voiceFileIcon">{icon}</span>
      <span className="voiceFileCopy">
        <strong>{title}</strong>
        <span>{hint}</span>
      </span>
      <code>{displayName}</code>
      <button className="iconButton" type="button" title={`选择${title}`} aria-label={`选择${title}`} onClick={onPick}>
        <FolderInput size={17} />
      </button>
    </div>
  );
}
