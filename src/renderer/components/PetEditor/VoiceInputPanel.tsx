import { CheckCircle2, KeyRound, Mic2, PlugZap, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  LocalPetSaveResult,
  LocalPetVoiceInputDraft,
  PetDefinition,
  PetVoiceInputSilenceSeconds
} from "../../../shared/types/pet";
import { PanelSaveActions } from "./EditorShared";

function createVoiceInputDraft(pet: PetDefinition): LocalPetVoiceInputDraft {
  const settings = pet.voiceInputSettings;
  const silenceSeconds = settings?.silenceSeconds;

  return {
    petId: pet.id,
    appId: settings?.appId ?? "",
    secretId: settings?.secretId ?? "",
    secretKey: settings?.secretKey ?? "",
    connected: settings?.connected ?? Boolean(pet.capabilities.voiceInput),
    autoEndEnabled: settings?.autoEndEnabled ?? true,
    silenceSeconds: silenceSeconds === 2 || silenceSeconds === 3 ? silenceSeconds : 1,
    volumeThreshold: settings?.volumeThreshold ?? 0.18,
    continuousConversationEnabled: settings?.continuousConversationEnabled ?? true
  };
}

export function VoiceInputPanel({
  pet,
  onSavedPet,
  onDirtyChange
}: {
  pet: PetDefinition;
  onSavedPet?: (pet: PetDefinition) => void;
  onDirtyChange: (dirty: boolean) => void;
}): JSX.Element {
  const [draft, setDraft] = useState<LocalPetVoiceInputDraft>(() => createVoiceInputDraft(pet));
  const [savedDraft, setSavedDraft] = useState<LocalPetVoiceInputDraft>(() => createVoiceInputDraft(pet));
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<LocalPetSaveResult | undefined>();
  const [connectionMessage, setConnectionMessage] = useState<string | undefined>();
  const lastVoiceInputPetIdRef = useRef<string | undefined>();
  const connected = draft.connected;

  useEffect(() => {
    const nextDraft = createVoiceInputDraft(pet);
    const isSamePet = lastVoiceInputPetIdRef.current === pet.id;

    setDraft(nextDraft);
    setSavedDraft(nextDraft);
    lastVoiceInputPetIdRef.current = pet.id;

    if (!isSamePet) {
      setResult(undefined);
      setConnectionMessage(undefined);
    }

    onDirtyChange(false);
  }, [onDirtyChange, pet]);

  const markVoiceInputDirty = (nextDraft: LocalPetVoiceInputDraft): void => {
    onDirtyChange(JSON.stringify(nextDraft) !== JSON.stringify(savedDraft));
  };

  const updateDraft = (patch: Partial<LocalPetVoiceInputDraft>): void => {
    setResult(undefined);
    setDraft((currentDraft) => {
      const nextDraft = {
        ...currentDraft,
        ...patch
      };

      markVoiceInputDirty(nextDraft);

      return nextDraft;
    });
  };

  const connectTencentAsr = (): void => {
    if (!draft.appId.trim() || !draft.secretId.trim() || !draft.secretKey.trim()) {
      updateDraft({ connected: false });
      setConnectionMessage("请先填写 AppID、SecretId 和 SecretKey。");
      return;
    }

    updateDraft({ connected: true });
    setConnectionMessage("连接信息已填写，可以继续配置语音输入。");
  };

  const saveVoiceInput = async (): Promise<void> => {
    if (pet.id === "new-pet") {
      setResult({
        ok: false,
        message: "请先保存基础信息，再配置语音输入。"
      });
      return;
    }

    setSaving(true);

    try {
      const saveResult = await window.desktopPet?.petConfig.saveVoiceInput(draft);

      if (!saveResult) {
        setResult({
          ok: false,
          message: "保存没有返回结果，请重试。"
        });
        return;
      }

      setResult(saveResult);

      if (saveResult.ok && saveResult.pet) {
        setSavedDraft(draft);
        onDirtyChange(false);
        onSavedPet?.(saveResult.pet);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="editorPanel">
      <div className="panelTitleRow">
        <div>
          <h2>语音输入</h2>
          <p>配置腾讯云实时语音识别，用于用户主动说话转文字。</p>
        </div>
        <span className={connected ? "connectionBadge ok" : "connectionBadge wait"}>
          {connected ? "已连接" : "待连接"}
        </span>
      </div>

      <section className="voiceSection" aria-label="腾讯云连接">
        <div className="voiceSectionHeader">
          <KeyRound size={19} />
          <h2>腾讯云实时语音识别</h2>
        </div>
        <div className="formGrid threeColumns">
          <label className="formField">
            <span>AppID</span>
            <input
              value={draft.appId}
              onChange={(event) => {
                updateDraft({
                  appId: event.target.value,
                  connected: false
                });
              }}
              placeholder="请输入 AppID"
            />
          </label>
          <label className="formField">
            <span>SecretId</span>
            <input
              value={draft.secretId}
              onChange={(event) => {
                updateDraft({
                  secretId: event.target.value,
                  connected: false
                });
              }}
              placeholder="请输入 SecretId"
            />
          </label>
          <label className="formField">
            <span>SecretKey</span>
            <input
              type="password"
              value={draft.secretKey}
              onChange={(event) => {
                updateDraft({
                  secretKey: event.target.value,
                  connected: false
                });
              }}
              placeholder="请输入 SecretKey"
            />
          </label>
        </div>
        <div className="settingsActions">
          <button className="secondaryAction" type="button" onClick={connectTencentAsr}>
            <PlugZap size={17} />
            连接
          </button>
        </div>
        {connectionMessage ? (
          <div className={connected ? "settingsResult ok" : "settingsResult error"}>
            {connected ? <CheckCircle2 size={17} /> : <XCircle size={17} />}
            <span>{connectionMessage}</span>
          </div>
        ) : null}
      </section>

      <section className={connected ? "dialogueSettings" : "dialogueSettings disabled"} aria-label="语音输入参数">
        <div className="settingsRowHeader">
          <div>
            <h3>自动识别说话结束</h3>
            <p>开启后，录音中检测到持续静音会自动结束并发送识别文本。</p>
          </div>
          <label className="settingsSwitch">
            <input
              type="checkbox"
              checked={draft.autoEndEnabled}
              disabled={!connected}
              onChange={(event) => {
                updateDraft({ autoEndEnabled: event.target.checked });
              }}
            />
            <span />
          </label>
        </div>

        <fieldset className="settingsField">
          <legend>静音超过多少时间自动结束</legend>
          <div className="segmentedControl">
            {([1, 2, 3] as PetVoiceInputSilenceSeconds[]).map((seconds) => (
              <button
                className={draft.silenceSeconds === seconds ? "segment active" : "segment"}
                type="button"
                disabled={!connected || !draft.autoEndEnabled}
                key={seconds}
                onClick={() => {
                  updateDraft({ silenceSeconds: seconds });
                }}
              >
                {seconds} 秒
              </button>
            ))}
          </div>
        </fieldset>

        <label className="settingsField">
          <span>音量阈值</span>
          <div className="rangeControl">
            <input
              type="range"
              min="4"
              max="45"
              step="1"
              value={Math.round(draft.volumeThreshold * 100)}
              disabled={!connected || !draft.autoEndEnabled}
              onChange={(event) => {
                updateDraft({ volumeThreshold: Number(event.target.value) / 100 });
              }}
            />
            <strong>{Math.round(draft.volumeThreshold * 100)}%</strong>
          </div>
        </label>

        <div className="settingsHint">
          <Mic2 size={16} />
          <span>建议普通房间使用 18% 左右。环境越吵，阈值越高；说话越轻，阈值越低。</span>
        </div>

        <div className="settingsRowHeader">
          <div>
            <h3>回复后继续录音</h3>
            <p>开启后，语音发送并收到 AI 回复后，会自动重新打开录音。</p>
          </div>
          <label className="settingsSwitch">
            <input
              type="checkbox"
              checked={draft.continuousConversationEnabled}
              disabled={!connected}
              onChange={(event) => {
                updateDraft({ continuousConversationEnabled: event.target.checked });
              }}
            />
            <span />
          </label>
        </div>
      </section>

      <PanelSaveActions
        onSave={() => void saveVoiceInput()}
        saving={saving}
        result={result}
        saved={Boolean(result?.ok)}
      />
    </div>
  );
}
