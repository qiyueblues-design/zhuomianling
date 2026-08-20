import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, CheckCircle2, Eye, EyeOff, FileCheck2, FolderOpen, LoaderCircle, PackageOpen, RefreshCw, ShieldCheck, Volume2, X, XCircle } from "lucide-react";
import { aiProviderOptions, findAiProviderByBaseUrl, type AiModelOption, type AiProviderSelectId } from "../../../shared/types/ai";
import type { PetDefinition } from "../../../shared/types/pet";
import type { PetPackageImportBeginResult, PetPackageProgress } from "../../../shared/types/petPackage";
import { PetPackageChoice } from "./PetPackageChoice";

type Step = "select" | "checking" | "ai" | "voice" | "confirm" | "done";

function formatBytes(value = 0): string {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = value;
  let index = -1;
  do { amount /= 1024; index += 1; } while (amount >= 1024 && index < units.length - 1);
  return `${amount.toFixed(amount >= 100 ? 0 : 1)} ${units[index]}`;
}

export function PetPackageImportDialog({ onClose, onImported }: { onClose: () => void; onImported: (pet: PetDefinition) => void }): JSX.Element {
  const [inspection, setInspection] = useState<PetPackageImportBeginResult>();
  const [step, setStep] = useState<Step>("select");
  const [showChecking, setShowChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [progress, setProgress] = useState<PetPackageProgress>();
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<AiModelOption[]>([]);
  const [providerName, setProviderName] = useState("OpenAI Compatible");
  const [modelsLoading, setModelsLoading] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [aiReady, setAiReady] = useState(false);
  const [voiceRoot, setVoiceRoot] = useState("");
  const [voiceReady, setVoiceReady] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const selectingRef = useRef(false);
  const checkingStartedRef = useRef(false);
  const checkingTimerRef = useRef<number>();

  const orderedSteps = useMemo(() => [
    "checking" as const,
    ...(inspection?.requirements?.ai ? ["ai" as const] : []),
    ...(inspection?.requirements?.gptSoVits ? ["voice" as const] : []),
    "confirm" as const
  ], [inspection?.requirements]);
  const stepIndex = Math.max(0, orderedSteps.indexOf(step as never));
  const selectedProviderId = useMemo<AiProviderSelectId>(() => findAiProviderByBaseUrl(baseUrl)?.id ?? "custom", [baseUrl]);

  useEffect(() => {
    dialogRef.current?.focus();
    const unsubscribe = window.desktopPet?.petPackage.onProgress((next) => {
      if (next.kind !== "import") return;
      setProgress(next);
      if (next.status !== "running") setBusy(false);
      if (selectingRef.current && next.status === "running" && !checkingStartedRef.current) {
        checkingStartedRef.current = true;
        setStep("checking");
        checkingTimerRef.current = window.setTimeout(() => setShowChecking(true), 300);
      }
    });
    return () => {
      if (checkingTimerRef.current !== undefined) window.clearTimeout(checkingTimerRef.current);
      unsubscribe?.();
    };
  }, []);

  const choosePackage = async (): Promise<void> => {
    if (selectingRef.current) return;
    selectingRef.current = true;
    checkingStartedRef.current = false;
    setInspection(undefined);
    setProgress(undefined);
    setError(undefined);
    setShowChecking(false);
    setBusy(true);
    try {
      const result = await window.desktopPet?.petPackage.beginImport();
      if (!result) throw new Error("桌宠包导入服务不可用。");
      if (!result.ok) {
        setStep("select");
        if (!result.canceled) setError(result.message);
        return;
      }
      setInspection(result);
      const next: Step = result.requirements?.ai ? "ai" : result.requirements?.gptSoVits ? "voice" : "confirm";
      setStep(next);
    } catch (reason: unknown) {
      setStep("select");
      setError(reason instanceof Error ? reason.message : "桌宠包检查失败。");
    } finally {
      if (checkingTimerRef.current !== undefined) window.clearTimeout(checkingTimerRef.current);
      checkingTimerRef.current = undefined;
      selectingRef.current = false;
      setBusy(false);
    }
  };

  const close = async (): Promise<void> => {
    if (busy && step === "confirm") return;
    const sessionId = inspection?.sessionId;
    setApiKey("");
    await window.desktopPet?.petPackage.cancelImport({ sessionId, operationId: progress?.operationId }).catch(() => undefined);
    onClose();
  };

  useEffect(() => {
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !(busy && step === "confirm")) { event.preventDefault(); void close(); }
      if (event.key === "Tab" && dialogRef.current) {
        const items = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])')];
        if (!items.length) return;
        const first = items[0]; const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  });

  const testAi = async (): Promise<void> => {
    if (!inspection?.sessionId) return;
    setBusy(true); setError(undefined); setAiReady(false);
    try {
      const result = await window.desktopPet?.petPackage.testImportAi({ sessionId: inspection.sessionId, draft: { baseUrl, apiKey, model } });
      setAiReady(Boolean(result?.ok));
      if (!result?.ok) setError(result?.message ?? "AI 检测失败。");
    } finally { setBusy(false); }
  };

  const resetModelSelection = (): void => {
    setModels([]);
    setModel("");
    setProviderName("OpenAI Compatible");
    setAiReady(false);
  };

  const updateProvider = (providerId: AiProviderSelectId): void => {
    resetModelSelection();
    if (providerId === "custom") {
      setBaseUrl("");
      return;
    }
    const provider = aiProviderOptions.find((option) => option.id === providerId);
    if (provider) {
      setBaseUrl(provider.baseUrl);
      setProviderName(provider.name);
    }
  };

  const loadModels = async (): Promise<void> => {
    if (!inspection?.sessionId || !baseUrl.trim() || !apiKey.trim()) return;
    setModelsLoading(true);
    setBusy(true);
    setError(undefined);
    setModels([]);
    setModel("");
    setAiReady(false);
    try {
      const result = await window.desktopPet?.petPackage.listImportAiModels({ sessionId: inspection.sessionId, baseUrl, apiKey });
      if (!result) throw new Error("模型列表服务不可用。");
      setProviderName(result.providerName);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      if (!result.models.length) {
        setError("服务连接成功，但没有返回可用模型。");
        return;
      }
      setModels(result.models);
      if (result.models.length === 1) setModel(result.models[0].id);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "获取模型列表失败。");
    } finally {
      setModelsLoading(false);
      setBusy(false);
    }
  };

  const pickVoiceRoot = async (): Promise<void> => {
    const result = await window.desktopPet?.petPackage.pickGptSoVitsRoot();
    if (result?.ok && result.directoryPath) { setVoiceRoot(result.directoryPath); setVoiceReady(false); setError(undefined); }
  };

  const testVoice = async (): Promise<void> => {
    if (!inspection?.sessionId || !voiceRoot) return;
    setBusy(true); setError(undefined); setVoiceReady(false);
    try {
      const result = await window.desktopPet?.petPackage.testImportVoice({ sessionId: inspection.sessionId, gptSoVitsRootPath: voiceRoot });
      setVoiceReady(Boolean(result?.ok));
      if (!result?.ok) setError(result?.message ?? "GPT-SoVITS 检测失败。");
    } finally { setBusy(false); }
  };

  const nextFromAi = (): void => setStep(inspection?.requirements?.gptSoVits ? "voice" : "confirm");
  const commit = async (): Promise<void> => {
    if (!inspection?.sessionId) return;
    setBusy(true); setError(undefined);
    try {
      const result = await window.desktopPet?.petPackage.commitImport({ sessionId: inspection.sessionId });
      if (result?.ok && result.pet) { setStep("done"); setApiKey(""); onImported(result.pet); return; }
      setError(result?.message ?? "安装失败。");
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "安装失败。");
    } finally {
      setBusy(false);
    }
  };

  const stageLabel: Record<string, string> = { inspect: "正在读取桌宠包", extract: "正在解压并校验文件", validate: "正在检查 Live2D 和语音资源", "test-ai": "正在测试 AI 输出能力", "test-voice": "正在测试 GPT-SoVITS 真实合成", commit: "正在完成安装，请勿关闭" };
  return (
    <div className="petPackageOverlay" role="presentation">
      <div className={inspection?.ok ? "petPackageDialog" : "petPackageDialog compact"} role="dialog" aria-modal="true" aria-labelledby="pet-package-import-title" tabIndex={-1} ref={dialogRef}>
        <header><span className="petPackageDialogIcon"><PackageOpen size={22} /></span><div><h2 id="pet-package-import-title">导入桌宠</h2><p>{inspection?.petName ?? (step === "select" ? "选择并验证 .zmling 桌宠包" : "安装 .zmling 桌宠包")}</p></div><button className="iconButton" aria-label="关闭导入向导" disabled={busy && step === "confirm"} onClick={() => void close()}><X size={18} /></button></header>
        {inspection?.ok ? <ol className="petPackageSteps" aria-label="导入步骤">{orderedSteps.map((item, index) => <li key={item} className={index < stepIndex ? "done" : index === stepIndex ? "active" : ""}><span>{index < stepIndex ? "✓" : index + 1}</span>{item === "checking" ? "检查" : item === "ai" ? "AI 配置" : item === "voice" ? "语音配置" : "安装"}</li>)}</ol> : null}
        <div className="petPackageBody">
          {step === "select" ? <section className="packageImportIntro"><span className="packageSectionTitle"><FileCheck2 size={19} /><h3>选择桌宠包</h3></span><p>选择文件后，桌面灵会完成安全检查；通过后再由你确认安装。</p><div className="packageInspectionNotice"><ShieldCheck size={20} /><div><strong>导入前会检查</strong><ul><li>文件清单与 SHA-256 哈希是否一致</li><li>压缩包路径、大小和资源类型是否安全</li><li>Live2D、语音资源和主题引用是否完整</li></ul></div></div><p className="packagePrivacyNote">请选择来自可信来源的 <strong>.zmling</strong> 文件。AI 密钥、连接信息、记忆和原作者的本机路径不会导入。</p></section> : null}
          {step === "checking" ? (showChecking ? <div className="packageCenteredStatus"><LoaderCircle className="spin" size={30} /><h3>正在检查桌宠包</h3><p>正在验证文件结构、哈希与资源安全性。</p></div> : <div className="packageQuietPlaceholder" />) : null}
          {step === "ai" ? <section>
            <span className="packageSectionTitle"><Bot size={19} /><h3>配置 AI 连接</h3></span>
            <p>桌面灵使用 OpenAI-compatible 接口。包内没有 API 或连接信息，凭据只会在安装成功后进入系统安全存储。</p>
            <div className="packageChoiceField"><span>服务</span><PetPackageChoice ariaLabel="AI 服务" value={selectedProviderId} disabled={busy} options={[...aiProviderOptions.map((provider) => ({ value: provider.id, label: provider.name })), { value: "custom", label: "自定义" }]} onChange={(value) => updateProvider(value as AiProviderSelectId)} /></div>
            <label><span>Base URL</span><input type="url" value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); resetModelSelection(); }} placeholder="https://api.example.com/v1" /></label>
            <label><span>API Key</span><span className="packageSecret"><input type={showSecret ? "text" : "password"} value={apiKey} onChange={(e) => { setApiKey(e.target.value); resetModelSelection(); }} /><button type="button" aria-label={showSecret ? "隐藏 API Key" : "显示 API Key"} onClick={() => setShowSecret((value) => !value)}>{showSecret ? <EyeOff size={17} /> : <Eye size={17} />}</button></span></label>
            <button className="secondaryAction" disabled={busy || !baseUrl.trim() || !apiKey.trim()} onClick={() => void loadModels()}>{modelsLoading ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}{modelsLoading ? "正在获取模型" : models.length ? "重新获取模型列表" : "获取模型列表"}</button>
            <div className="packageChoiceField"><span>模型</span><PetPackageChoice searchable ariaLabel="AI 模型" value={model} disabled={!models.length || busy} options={models.map((option) => ({ value: option.id, label: option.name || option.id }))} placeholder={models.length ? "输入关键词或从列表中选择" : "请先获取模型列表"} onChange={(value) => { setModel(value); setAiReady(false); }} />{models.length ? <small className="packageModelCount" role="status">{providerName} · 已获取 {models.length} 个可用模型</small> : null}</div>
            <button className="secondaryAction" disabled={busy || !model || !models.some((option) => option.id === model)} onClick={() => void testAi()}>{busy && !modelsLoading ? <LoaderCircle className="spin" size={16} /> : <Bot size={16} />}{aiReady ? "检测通过" : "测试模型和输出能力"}</button>
          </section> : null}
          {step === "voice" ? <section><span className="packageSectionTitle"><Volume2 size={19} /><h3>配置 GPT-SoVITS</h3></span><p>声音模型和参考音频已在包内；请选择本机 GPT-SoVITS 完整文件夹，向导会检查运行环境与预训练模型目录。</p><label><span>GPT-SoVITS 根目录</span><span className="packagePicker"><input readOnly value={voiceRoot} placeholder="请选择完整文件夹" /><button className="secondaryAction" onClick={() => void pickVoiceRoot()}><FolderOpen size={16} />选择</button></span></label><button className="secondaryAction" disabled={busy || !voiceRoot} onClick={() => void testVoice()}>{busy ? <LoaderCircle className="spin" size={16} /> : <Volume2 size={16} />}{voiceReady ? "目录检测通过" : "检测完整目录"}</button></section> : null}
          {step === "confirm" ? <section><span className="packageSectionTitle"><CheckCircle2 size={19} /><h3>确认安装</h3></span>{inspection?.avatarDataUrl ? <img className="packageAvatar" src={inspection.avatarDataUrl} alt="桌宠头像预览" /> : null}<dl className="packageSummary"><div><dt>桌宠</dt><dd>{inspection?.petName}</dd></div><div><dt>Live2D</dt><dd>完整资源</dd></div><div><dt>AI</dt><dd>{inspection?.requirements?.ai ? "已检测" : "不需要"}</dd></div><div><dt>语音</dt><dd>{inspection?.requirements?.gptSoVits ? "完整目录已检测" : "不需要"}</dd></div></dl><p className="packagePrivacyNote">不会导入记忆、腾讯云配置或原作者的 API 信息。</p></section> : null}
          {step === "done" ? <div className="packageCenteredStatus success"><CheckCircle2 size={34} /><h3>桌宠已安装</h3><p>新桌宠已加入主页列表。</p></div> : null}
          {progress && progress.status === "running" && (step === "checking" || busy) ? <div className="packageProgress" role="status"><div><strong>{stageLabel[progress.stage] ?? "正在处理"}</strong>{progress.percent !== undefined ? <span>{Math.round(progress.percent * 100)}%</span> : <LoaderCircle className="spin" size={16} />}</div>{progress.percent !== undefined ? <progress max={1} value={progress.percent} /> : null}{progress.totalBytes > 0 ? <small>已处理 {formatBytes(progress.processedBytes)} / {formatBytes(progress.totalBytes)}</small> : null}</div> : null}
          {error ? <div className="packageError" role="alert"><XCircle size={18} /><span>{error}</span></div> : null}
        </div>
        <footer>
          <span>{inspection?.ok && step !== "done" ? `第 ${stepIndex + 1} 步，共 ${orderedSteps.length} 步` : ""}</span>
          <div>
            {step === "select" ? <button className="primaryAction" disabled={busy} onClick={() => void choosePackage()}><FolderOpen size={16} />选择 .zmling 文件</button> : null}
            {step === "ai" ? <button className="primaryAction" disabled={!aiReady || busy} onClick={nextFromAi}>下一步</button> : null}
            {step === "voice" ? <>
              {inspection?.requirements?.ai ? <button className="secondaryAction" disabled={busy} onClick={() => setStep("ai")}>返回</button> : null}
              <button className="primaryAction" disabled={!voiceReady || busy} onClick={() => setStep("confirm")}>下一步</button>
            </> : null}
            {step === "confirm" ? <>
              {inspection?.requirements?.gptSoVits || inspection?.requirements?.ai ? <button className="secondaryAction" disabled={busy} onClick={() => setStep(inspection.requirements?.gptSoVits ? "voice" : "ai")}>返回</button> : null}
              <button className="primaryAction" disabled={busy} onClick={() => void commit()}>{busy ? "正在完成安装" : "安装桌宠"}</button>
            </> : null}
            {step === "done" ? <button className="primaryAction" onClick={onClose}>完成</button> : null}
          </div>
        </footer>
      </div>
    </div>
  );
}
