import { KeyRound, PlugZap, Save, XCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { normalizeAiBaseUrl } from "../../../shared/types/ai";
import type {
  AiConnectionDraft,
  AiConnectionSaveResult,
  AiConnectionSummary,
  AiModelListResult,
  AiModelOption
} from "../../../shared/types/ai";
import type { PetDefinition } from "../../../shared/types/pet";
import { AppleSelect, SaveSuccessToast } from "./EditorShared";

interface AiSettingsForm {
  petId: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

interface AiProviderOption {
  id: "deepseek" | "openai" | "gemini";
  name: string;
  baseUrl: string;
}

type AiProviderSelectId = AiProviderOption["id"] | "custom";

const aiProviderOptions: AiProviderOption[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com"
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com"
  },
  {
    id: "gemini",
    name: "Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai"
  }
];

const aiProviderSelectOptions: { value: AiProviderSelectId; label: string }[] = [
  ...aiProviderOptions.map((provider) => ({
    value: provider.id,
    label: provider.name
  })),
  {
    value: "custom",
    label: "自定义"
  }
];

function findProviderByBaseUrl(baseUrl: string): AiProviderOption | undefined {
  const normalizedBaseUrl = normalizeAiBaseUrl(baseUrl);

  return aiProviderOptions.find(
    (provider) => normalizeAiBaseUrl(provider.baseUrl) === normalizedBaseUrl
  );
}

function getProviderName(baseUrl: string): string {
  return findProviderByBaseUrl(baseUrl)?.name ?? "Custom OpenAI Compatible";
}

export function AiPanel({
  pet,
  onDirtyChange
}: {
  pet: PetDefinition;
  onDirtyChange: (dirty: boolean) => void;
}): JSX.Element {
  const [summary, setSummary] = useState<AiConnectionSummary | undefined>();
  const [models, setModels] = useState<AiModelOption[]>([]);
  const [form, setForm] = useState<AiSettingsForm>({
    petId: pet.id,
    baseUrl: aiProviderOptions[0].baseUrl,
    model: "",
    apiKey: ""
  });
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [loadingSummary, setLoadingSummary] = useState(true);
  const [result, setResult] = useState<AiConnectionSaveResult | undefined>();
  const [modelResult, setModelResult] = useState<AiModelListResult | undefined>();
  const [asyncError, setAsyncError] = useState<string>();
  const requestSequenceRef = useRef(0);

  const selectedProviderId = useMemo(() => {
    return findProviderByBaseUrl(form.baseUrl)?.id ?? "custom";
  }, [form.baseUrl]);
  const normalizedFormBaseUrl = useMemo(
    () => normalizeAiBaseUrl(form.baseUrl),
    [form.baseUrl]
  );
  const normalizedSavedBaseUrl = useMemo(
    () => normalizeAiBaseUrl(summary?.baseUrl ?? ""),
    [summary?.baseUrl]
  );
  const canReuseSavedApiKey = Boolean(
    summary?.hasApiKey &&
    normalizedFormBaseUrl &&
    normalizedFormBaseUrl === normalizedSavedBaseUrl
  );
  const hasEnteredApiKey = Boolean(form.apiKey.trim());
  const hasUsableApiKey = hasEnteredApiKey || canReuseSavedApiKey;
  const savedKeyBelongsToAnotherEndpoint = Boolean(
    summary?.hasApiKey &&
    normalizedFormBaseUrl &&
    normalizedFormBaseUrl !== normalizedSavedBaseUrl
  );
  const credentialMessage = loadingSummary
    ? undefined
    : !normalizedFormBaseUrl
      ? "请先填写 Base URL。"
      : hasUsableApiKey
        ? undefined
        : savedKeyBelongsToAnotherEndpoint
          ? "Base URL 已更改。为避免把旧密钥发送到新地址，请输入新地址自己的 API Key。"
          : "请填写 API Key；只有 Base URL 与已保存地址一致时，才能复用本机旧密钥。";
  const formDisabled = loadingSummary || saving || connecting;
  const saveFeedbackResult = useMemo(
    () => (result?.test.ok ? { ok: true, message: result.test.message } : undefined),
    [result]
  );
  const modelFeedbackResult = useMemo(
    () => (modelResult?.ok ? { ok: true, message: modelResult.message } : undefined),
    [modelResult]
  );

  useEffect(() => {
    let cancelled = false;
    const requestId = requestSequenceRef.current + 1;
    requestSequenceRef.current = requestId;

    setLoadingSummary(true);
    setConnecting(false);
    setSaving(false);
    setSummary(undefined);
    setModels([]);
    setResult(undefined);
    setModelResult(undefined);
    setAsyncError(undefined);
    setForm({
      petId: pet.id,
      baseUrl: aiProviderOptions[0].baseUrl,
      model: "",
      apiKey: ""
    });

    const loadSummary = async (): Promise<void> => {
      try {
        const nextSummary = await window.desktopPet?.aiSettings.get(pet.id);

        if (cancelled || requestId !== requestSequenceRef.current) {
          return;
        }

        setSummary(nextSummary);

        if (!nextSummary) {
          return;
        }

        const savedModels = nextSummary.models.length
          ? nextSummary.models
          : nextSummary.model
            ? [{ id: nextSummary.model, name: nextSummary.model }]
            : [];

        setModels(savedModels);
        setForm({
          petId: pet.id,
          baseUrl: nextSummary.baseUrl,
          model: nextSummary.model,
          apiKey: ""
        });
      } catch (error) {
        if (!cancelled && requestId === requestSequenceRef.current) {
          console.error("Failed to load AI settings summary.", error);
          setAsyncError("读取已保存的 AI 设置失败，请稍后重试。为了保护密钥，当前不会复用旧配置。");
        }
      } finally {
        if (!cancelled && requestId === requestSequenceRef.current) {
          setLoadingSummary(false);
        }
      }
    };

    void loadSummary();

    return () => {
      cancelled = true;
      requestSequenceRef.current += 1;
    };
  }, [pet.id]);

  useEffect(() => {
    if (!modelResult?.ok) {
      return;
    }

    const timer = window.setTimeout(() => {
      setModelResult(undefined);
    }, 2200);

    return () => {
      window.clearTimeout(timer);
    };
  }, [modelResult]);

  useEffect(() => {
    if (!result?.test.ok) {
      return;
    }

    const timer = window.setTimeout(() => {
      setResult(undefined);
    }, 2200);

    return () => {
      window.clearTimeout(timer);
    };
  }, [result]);

  const updateField = (field: keyof AiSettingsForm, value: string): void => {
    onDirtyChange(true);
    setResult(undefined);
    setModelResult(undefined);
    setAsyncError(undefined);

    if (field === "baseUrl") {
      setModels([]);
      setForm((currentForm) => ({
        ...currentForm,
        baseUrl: value,
        apiKey: "",
        model: ""
      }));
      return;
    }

    if (field === "apiKey") {
      setModels([]);
      setForm((currentForm) => ({
        ...currentForm,
        apiKey: value,
        model: ""
      }));
      return;
    }

    setForm((currentForm) => ({
      ...currentForm,
      [field]: value
    }));
  };

  const updateProvider = (providerId: string): void => {
    if (providerId === "custom") {
      setResult(undefined);
      setModelResult(undefined);
      setAsyncError(undefined);
      onDirtyChange(true);
      setModels([]);
      setForm((currentForm) => ({
        ...currentForm,
        baseUrl: findProviderByBaseUrl(currentForm.baseUrl) ? "" : currentForm.baseUrl,
        apiKey: "",
        model: ""
      }));
      return;
    }

    const provider = aiProviderOptions.find((option) => option.id === providerId);

    if (!provider) {
      return;
    }

    setResult(undefined);
    setModelResult(undefined);
    setAsyncError(undefined);
    onDirtyChange(true);
    setModels([]);
    setForm((currentForm) => ({
      ...currentForm,
      baseUrl: provider.baseUrl,
      apiKey: "",
      model: ""
    }));
  };

  const buildDraft = (): AiConnectionDraft => {
    return {
      petId: form.petId,
      providerName: getProviderName(form.baseUrl),
      baseUrl: form.baseUrl,
      model: form.model,
      apiKey: form.apiKey,
      models
    };
  };

  const connectModels = async (): Promise<void> => {
    if (!hasUsableApiKey) {
      setAsyncError(credentialMessage ?? "请填写当前 Base URL 对应的 API Key。");
      return;
    }

    const requestId = requestSequenceRef.current + 1;
    requestSequenceRef.current = requestId;
    setConnecting(true);
    setResult(undefined);
    setModelResult(undefined);
    setAsyncError(undefined);

    try {
      const nextResult = await window.desktopPet?.aiSettings.listModels(buildDraft());

      if (requestId !== requestSequenceRef.current) {
        return;
      }

      if (!nextResult) {
        setAsyncError("连接没有返回结果，请稍后重试。");
        return;
      }

      setModelResult(nextResult);
      setModels(nextResult.models);

      if (nextResult.models.length) {
        onDirtyChange(true);
        setForm((currentForm) => ({
          ...currentForm,
          model:
            nextResult.models.find((model) => model.id === currentForm.model)?.id ??
            nextResult.models[0]?.id ??
            ""
        }));
      }
    } catch (error) {
      if (requestId === requestSequenceRef.current) {
        console.error("Failed to list AI models.", error);
        setAsyncError("连接 AI 服务失败，请检查 Base URL、API Key 和网络后重试。");
      }
    } finally {
      if (requestId === requestSequenceRef.current) {
        setConnecting(false);
      }
    }
  };

  const saveSettings = async (): Promise<void> => {
    if (!hasUsableApiKey) {
      setAsyncError(credentialMessage ?? "请填写当前 Base URL 对应的 API Key。");
      return;
    }

    const requestId = requestSequenceRef.current + 1;
    requestSequenceRef.current = requestId;
    setSaving(true);
    setResult(undefined);
    setAsyncError(undefined);

    try {
      const nextResult = await window.desktopPet?.aiSettings.save(buildDraft());

      if (requestId !== requestSequenceRef.current) {
        return;
      }

      if (!nextResult) {
        setAsyncError("保存没有返回结果，请稍后重试。");
        return;
      }

      setResult(nextResult);
      setSummary(nextResult.config);

      if (nextResult.test.ok) {
        onDirtyChange(false);
        setForm((currentForm) => ({
          ...currentForm,
          apiKey: ""
        }));
      }
    } catch (error) {
      if (requestId === requestSequenceRef.current) {
        console.error("Failed to save AI settings.", error);
        setAsyncError("保存 AI 设置失败，请检查连接信息后重试。");
      }
    } finally {
      if (requestId === requestSequenceRef.current) {
        setSaving(false);
      }
    }
  };

  return (
    <div className="editorPanel llmConfigPanel">
      <div className="panelTitleRow">
        <div>
          <h2>LLM配置</h2>
          <p>配置 {pet.name} 的 OpenAI-compatible 模型连接，API Key 只保存到本机。</p>
        </div>
        <span className={summary?.model ? "connectionBadge ok" : "connectionBadge wait"}>
          {loadingSummary ? "读取中" : summary?.model ? "已保存" : "待连接"}
        </span>
      </div>

      <div className="settingsForm llmSettingsForm">
        <label className="settingsField">
          <span>桌宠</span>
          <input value={pet.name} readOnly />
        </label>

        <label className="settingsField">
          <span>服务商</span>
          <AppleSelect
            value={selectedProviderId}
            disabled={formDisabled}
            ariaLabel="服务商"
            options={aiProviderSelectOptions}
            onChange={updateProvider}
          />
        </label>

        <label className="settingsField">
          <span>Base URL</span>
          <input
            type="url"
            value={form.baseUrl}
            disabled={formDisabled}
            onChange={(event) => updateField("baseUrl", event.target.value)}
            placeholder="https://api.example.com"
          />
        </label>

        <label className="settingsField">
          <span>API Key</span>
          <div className="secretInputWrap">
            <KeyRound size={16} />
            <input
              type="password"
              value={form.apiKey}
              disabled={formDisabled}
              onChange={(event) => updateField("apiKey", event.target.value)}
              placeholder={
                loadingSummary
                  ? "正在读取已保存配置"
                  : canReuseSavedApiKey
                    ? "同一地址已保存，留空可复用"
                    : savedKeyBelongsToAnotherEndpoint
                      ? "请输入新地址自己的 API Key"
                      : "sk-..."
              }
            />
          </div>
        </label>

        <label className="settingsField">
          <span>模型名</span>
          {models.length ? (
            <AppleSelect
              value={form.model}
              disabled={formDisabled}
              ariaLabel="模型名"
              placeholder="请选择模型"
              options={models.map((model) => ({
                value: model.id,
                label: model.name
              }))}
              onChange={(nextModel) => updateField("model", nextModel)}
            />
          ) : (
            <input
              value={form.model}
              disabled={formDisabled}
              onChange={(event) => updateField("model", event.target.value)}
              placeholder="可连接获取列表，也可手动填写模型名"
            />
          )}
        </label>
      </div>

      <div className="settingsHint">
        <PlugZap size={16} />
        <span>可选择预设服务商自动填入 Base URL，也可以选择自定义后手动填写兼容 OpenAI 接口的地址。</span>
      </div>

      {credentialMessage ? (
        <div className="settingsResult error">
          <XCircle size={17} />
          <span>{credentialMessage}</span>
        </div>
      ) : null}

      {asyncError ? (
        <div className="settingsResult error" role="alert">
          <XCircle size={17} />
          <span>{asyncError}</span>
        </div>
      ) : null}

      <SaveSuccessToast result={modelFeedbackResult} message={modelResult?.message ?? "连接成功"} />

      {modelResult && !modelResult.ok ? (
        <div className="settingsResult error">
          <XCircle size={17} />
          <span>{modelResult.message}</span>
        </div>
      ) : null}

      <SaveSuccessToast result={saveFeedbackResult} />

      {result && !result.test.ok ? (
        <div className="settingsResult error">
          <XCircle size={17} />
          <span>{result.test.message}</span>
        </div>
      ) : null}

      <div className="settingsActions llmSettingsActions">
        <button
          className="secondaryAction"
          type="button"
          disabled={connecting || saving || loadingSummary || !hasUsableApiKey}
          onClick={() => void connectModels()}
        >
          <PlugZap size={17} />
          {connecting ? "连接中" : "连接"}
        </button>
        <button
          className="primaryAction"
          type="button"
          disabled={saving || connecting || loadingSummary || !form.model || !hasUsableApiKey}
          onClick={() => void saveSettings()}
        >
          <Save size={17} />
          {saving ? "保存中" : "保存设置"}
        </button>
      </div>
    </div>
  );
}
