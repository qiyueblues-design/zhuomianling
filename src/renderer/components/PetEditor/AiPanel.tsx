import { KeyRound, PlugZap, Save, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");

  return aiProviderOptions.find((provider) => provider.baseUrl === normalizedBaseUrl);
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
  const [result, setResult] = useState<AiConnectionSaveResult | undefined>();
  const [modelResult, setModelResult] = useState<AiModelListResult | undefined>();

  const selectedProviderId = useMemo(() => {
    return findProviderByBaseUrl(form.baseUrl)?.id ?? "custom";
  }, [form.baseUrl]);
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

    setSummary(undefined);
    setModels([]);
    setResult(undefined);
    setModelResult(undefined);
    setForm({
      petId: pet.id,
      baseUrl: aiProviderOptions[0].baseUrl,
      model: "",
      apiKey: ""
    });

    void window.desktopPet?.aiSettings.get(pet.id).then((nextSummary) => {
      if (cancelled) {
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
    });

    return () => {
      cancelled = true;
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

    if (field === "baseUrl" || field === "apiKey") {
      setModels([]);
      setForm((currentForm) => ({
        ...currentForm,
        [field]: value,
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
      onDirtyChange(true);
      setModels([]);
      setForm((currentForm) => ({
        ...currentForm,
        baseUrl: findProviderByBaseUrl(currentForm.baseUrl) ? "" : currentForm.baseUrl,
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
    onDirtyChange(true);
    setModels([]);
    setForm((currentForm) => ({
      ...currentForm,
      baseUrl: provider.baseUrl,
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
    setConnecting(true);
    setResult(undefined);

    try {
      const nextResult = await window.desktopPet?.aiSettings.listModels(buildDraft());

      if (!nextResult) {
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
    } finally {
      setConnecting(false);
    }
  };

  const saveSettings = async (): Promise<void> => {
    setSaving(true);

    try {
      const nextResult = await window.desktopPet?.aiSettings.save(buildDraft());

      if (!nextResult) {
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
    } finally {
      setSaving(false);
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
          {summary?.model ? "已保存" : "待连接"}
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
              onChange={(event) => updateField("apiKey", event.target.value)}
              placeholder={summary?.hasApiKey ? "已保存，重新填写可覆盖" : "sk-..."}
            />
          </div>
        </label>

        <label className="settingsField">
          <span>模型名</span>
          {models.length ? (
            <AppleSelect
              value={form.model}
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
          disabled={connecting || saving}
          onClick={() => void connectModels()}
        >
          <PlugZap size={17} />
          {connecting ? "连接中" : "连接"}
        </button>
        <button
          className="primaryAction"
          type="button"
          disabled={saving || connecting || !form.model}
          onClick={() => void saveSettings()}
        >
          <Save size={17} />
          {saving ? "保存中" : "保存设置"}
        </button>
      </div>
    </div>
  );
}
