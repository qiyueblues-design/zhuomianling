import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Archive, CheckCircle2, LoaderCircle, X, XCircle } from "lucide-react";
import type { PetDefinition } from "../../../shared/types/pet";
import type { PetPackageExportInspection, PetPackageProgress } from "../../../shared/types/petPackage";

const formatBytes = (value = 0): string => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MB` : `${Math.ceil(value / 1024)} KB`;

export function PetPackageExportDialog({ pet, onClose }: { pet: PetDefinition; onClose: () => void }): JSX.Element {
  const [inspection, setInspection] = useState<PetPackageExportInspection>();
  const [progress, setProgress] = useState<PetPackageProgress>();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string }>();
  const dialogRef = useRef<HTMLDivElement>(null);
  const exportRequestedRef = useRef(false);
  const activeOperationIdRef = useRef<string>();
  useEffect(() => {
    dialogRef.current?.focus();
    void window.desktopPet?.petPackage.inspectExport(pet.id).then(setInspection);
    return window.desktopPet?.petPackage.onProgress((next) => {
      if (next.kind !== "export" || !exportRequestedRef.current) return;
      if (!activeOperationIdRef.current) {
        if (next.status !== "running") return;
        activeOperationIdRef.current = next.operationId;
      }
      if (activeOperationIdRef.current !== next.operationId) return;
      setProgress(next);
      if (next.status === "success") {
        setResult((current) => current ?? { ok: true, message: "桌宠包已安全保存。" });
        setBusy(false);
      } else if (next.status === "failed") {
        setResult((current) => current ?? { ok: false, message: "导出失败。" });
        setBusy(false);
      } else if (next.status === "canceled") {
        setBusy(false);
      }
    });
  }, [pet.id]);
  const cancelOrClose = async (): Promise<void> => {
    if (busy && progress?.operationId) {
      await window.desktopPet?.petPackage.cancelOperation(progress.operationId);
      return;
    }
    onClose();
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent): void => { if (event.key === "Escape") void cancelOrClose(); };
    document.addEventListener("keydown", listener); return () => document.removeEventListener("keydown", listener);
  });
  const runExport = async (): Promise<void> => {
    exportRequestedRef.current = true;
    activeOperationIdRef.current = undefined;
    setBusy(true); setResult(undefined);
    try {
      const next = await window.desktopPet?.petPackage.export(pet.id);
      if (next && !next.canceled) setResult({ ok: next.ok, message: next.message });
    } catch (error) { setResult({ ok: false, message: error instanceof Error ? error.message : "导出失败。" }); setBusy(false); }
    finally {
      exportRequestedRef.current = false;
      activeOperationIdRef.current = undefined;
      setBusy(false);
    }
  };
  return <div className="petPackageOverlay"><div className="petPackageDialog export" role="dialog" aria-modal="true" aria-labelledby="package-export-title" tabIndex={-1} ref={dialogRef}>
    <header><span className="petPackageDialogIcon"><Archive size={22} /></span><div><h2 id="package-export-title">导出桌宠</h2><p>{pet.name}</p></div><button className="iconButton" aria-label="关闭" onClick={() => void cancelOrClose()}><X size={18} /></button></header>
    <div className="petPackageBody">{!inspection ? <div className="packageCenteredStatus"><LoaderCircle className="spin" size={28} /><h3>正在检查桌宠资源</h3></div> : inspection.ok ? <><section><h3>桌宠包将包含</h3><ul><li>基础信息、当前主题与完整 Live2D</li><li>人设、台词、事件与表情配置</li><li>{inspection.requirements?.gptSoVits ? "GPT-SoVITS 的 .pth、.ckpt 模型、参考音频，以及预设和心情语音" : "已配置的预设和心情语音（如有）"}</li></ul></section><section><h3>不会包含</h3><ul><li>AI 密钥、Base URL 与模型连接设置</li><li>GPT-SoVITS 程序目录、记忆与腾讯云语音识别配置</li></ul></section><div className="packageSize"><span>预计资源大小</span><strong>{formatBytes(inspection.estimatedBytes)}</strong></div>{(inspection.estimatedBytes ?? 0) > 500 * 1024 ** 2 ? <p className="packagePrivacyNote"><AlertTriangle size={16} />声音权重较大，导出可能需要数分钟。</p> : null}</> : <div className="packageError"><XCircle size={18} /><span>{inspection.message}</span></div>}
      {progress?.status === "running" && busy ? <div className="packageProgress" role="status"><div><strong>{progress.stage === "archive" ? "正在计算校验并压缩资源" : "正在安全保存桌宠包"}</strong>{progress.percent !== undefined ? <span>{Math.round(progress.percent * 100)}%</span> : null}</div>{progress.percent !== undefined ? <progress max={1} value={progress.percent} /> : null}<small>已处理 {formatBytes(progress.processedBytes)} / {formatBytes(progress.totalBytes)}</small></div> : null}
      {result ? <div className={result.ok ? "packageResult success" : "packageError"}>{result.ok ? <CheckCircle2 size={18} /> : <XCircle size={18} />}<span>{result.message}</span></div> : null}
    </div><footer><span /><div><button className="secondaryAction" onClick={() => void cancelOrClose()}>{result?.ok ? "完成" : busy ? "取消导出" : "取消"}</button>{!result?.ok ? <button className="primaryAction" disabled={busy || !inspection?.ok} onClick={() => void runExport()}>{busy ? "正在导出" : "选择位置并导出"}</button> : null}</div></footer>
  </div></div>;
}
