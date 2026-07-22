import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { FileAudio, Gauge, Play, Trash2, Volume2 } from "lucide-react";
import { petMoodRanges, type PetMoodRangeId } from "../../../shared/mood";
import type { LocalPetSaveResult, PetDefinition, PetMoodSettings } from "../../../shared/types/pet";
import type { PetMoodDisplayState } from "../../../shared/types/mood";
import { AppleSelect, PanelSaveActions } from "./EditorShared";

const defaultRangeId: PetMoodRangeId = "calm";

export function MoodPanel({ pet, onSavedPet, onDirtyChange }: { pet: PetDefinition; onSavedPet?: (pet: PetDefinition) => void; onDirtyChange: (dirty: boolean) => void }): JSX.Element {
  const [settings, setSettings] = useState<PetMoodSettings>(pet.moodSettings ?? {});
  const [display, setDisplay] = useState<PetMoodDisplayState>();
  const [selectedRangeId, setSelectedRangeId] = useState<PetMoodRangeId>(defaultRangeId);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<LocalPetSaveResult>();
  const [dirty, setDirty] = useState(false);
  const [voiceTexts, setVoiceTexts] = useState<Partial<Record<PetMoodRangeId, string>>>({});
  const voiceConnected = Boolean(pet.voiceModelSettings?.connected && pet.voiceModelSettings.enabled);
  const sourceOptions = useMemo(() => [{ value: "", label: "无" }, ...(pet.expressionSources ?? []).map((source) => ({
    value: `${source.sourceKind}:${source.sourceFileName}:${String(source.runtimeName ?? "")}`,
    label: `${source.sourceKind === "motion" ? "动作" : "表情"} · ${source.description || source.sourceFileName}`
  }))], [pet.expressionSources]);

  useEffect(() => {
    setSettings(pet.moodSettings ?? {});
    setVoiceTexts(Object.fromEntries(petMoodRanges.map((range) => [range.id, pet.moodSettings?.ranges?.[range.id]?.voiceOverride?.referenceText ?? ""])));
    setSelectedRangeId(defaultRangeId);
    setDisplay(undefined);
    setDirty(false);
    onDirtyChange(false);
  }, [pet.id, pet.moodSettings, onDirtyChange]);

  useEffect(() => {
    let active = true;
    void window.desktopPet?.mood.getEditorState(pet.id).then((state) => {
      if (!active) return;
      setDisplay(state.display);
      setSelectedRangeId(state.display.rangeId);
    }).catch(() => {
      if (active) setResult({ ok: false, message: "心情状态读取失败，请重试。" });
    });
    return () => { active = false; };
  }, [pet.id]);

  const updateRange = (id: PetMoodRangeId, patch: Record<string, unknown>): void => {
    setSettings((current) => ({ ranges: { ...(current.ranges ?? {}), [id]: { ...(current.ranges?.[id] ?? {}), ...patch } } }));
    setDirty(true);
    onDirtyChange(true);
    setResult(undefined);
  };

  const save = async (): Promise<void> => {
    const missingReferenceText = Object.values(settings.ranges ?? {}).some((range) =>
      Boolean(range.voiceOverride) && !range.voiceOverride?.referenceText.trim()
    );
    if (missingReferenceText) {
      setResult({ ok: false, message: "请填写参考音频中实际说出的内容后再保存。" });
      return;
    }
    setSaving(true);
    try {
      const next = await window.desktopPet?.mood.saveSettings({ petId: pet.id, settings });
      setResult(next ?? { ok: false, message: "心情配置保存失败。" });
      if (next?.ok && next.pet) {
        setDirty(false);
        onDirtyChange(false);
        onSavedPet?.(next.pet);
      }
    } finally {
      setSaving(false);
    }
  };

  const importVoice = async (id: PetMoodRangeId): Promise<void> => {
    const referenceText = voiceTexts[id]?.trim() ?? "";
    try {
      const imported = await window.desktopPet?.mood.importRangeVoice({ petId: pet.id, rangeId: id, referenceText });
      if (imported?.ok && imported.fileName) {
        setSettings((current) => ({ ranges: { ...(current.ranges ?? {}), [id]: { ...(current.ranges?.[id] ?? {}), voiceOverride: { referenceAudio: imported.fileName!, referenceText } } } }));
        setDirty(!imported.persisted);
        onDirtyChange(!imported.persisted);
      }
      if (imported && !imported.canceled) setResult({ ok: imported.ok, message: imported.message });
    } catch {
      setResult({ ok: false, message: "参考音频选择失败，请重试。" });
    }
  };

  const removeVoice = async (id: PetMoodRangeId): Promise<void> => {
    const removed = await window.desktopPet?.mood.removeRangeVoice({ petId: pet.id, rangeId: id });
    if (removed?.ok) {
      const next = { ...(settings.ranges ?? {}) };
      const current = next[id];
      if (current) {
        const { voiceOverride: _voice, ...rest } = current;
        if (Object.keys(rest).length) next[id] = rest;
        else delete next[id];
      }
      setSettings({ ranges: next });
      setDirty(false);
      onDirtyChange(false);
      if (removed.pet) onSavedPet?.(removed.pet);
    }
    if (removed) setResult(removed);
  };

  const selectedRange = petMoodRanges.find((range) => range.id === selectedRangeId) ?? petMoodRanges[3];
  const isCalmRange = selectedRange.id === "calm";
  const rangeSettings = settings.ranges?.[selectedRange.id];
  const source = rangeSettings?.enterSource;
  const enterLine = rangeSettings?.enterLine ?? "";
  const sourceValue = source ? `${source.sourceKind}:${source.sourceFileName}:${String(source.runtimeName ?? "")}` : "";
  const voice = rangeSettings?.voiceOverride;
  const configuredRangeCount = petMoodRanges.filter((range) => {
    const current = settings.ranges?.[range.id];
    return Boolean(current?.enterSource || current?.enterLine || current?.voiceOverride);
  }).length;
  const moodPosition = display ? `${Math.max(0, Math.min(100, (display.value + 100) / 2))}%` : "50%";
  const overviewStyle = { "--mood-position": moodPosition } as CSSProperties;

  return <section className="editorPanel moodPanel" aria-label="心情设置">
    <div className="moodHero">
      <div className="moodHeroTitle">
        <span className="moodHeroIcon" aria-hidden="true"><Gauge size={22} /></span>
        <div>
          <h2>心情</h2>
          <p>为七个心情区间分别设置进入表现与语音。区间边界、事件影响和时间回落由系统管理。</p>
        </div>
      </div>
      <div className="moodCurrent" aria-live="polite">
        <span>当前状态</span>
        {display ? <><strong>{display.value}</strong><em>{display.label}</em></> : <><strong className="loading">···</strong><em>正在读取</em></>}
      </div>
    </div>

    <div className="moodOverview" style={overviewStyle}>
      <div className="moodOverviewMeta">
        <div><strong>心情区间</strong><span>选择一个区间进行配置</span></div>
        <span>{configuredRangeCount} / {petMoodRanges.length} 个区间已配置</span>
      </div>
      <div className="moodScale" role="tablist" aria-label="选择心情区间">
        <span className="moodScaleTrack" aria-hidden="true">
          <i className={display ? "moodValueMarker" : "moodValueMarker loading"} data-value={display?.value ?? ""} />
        </span>
        {petMoodRanges.map((range) => {
          const current = display?.rangeId === range.id;
          const selected = selectedRange.id === range.id;
          const configured = Boolean(settings.ranges?.[range.id]?.enterSource || settings.ranges?.[range.id]?.enterLine || settings.ranges?.[range.id]?.voiceOverride);
          return <button
            className={["moodScaleOption", selected ? "selected" : "", current ? "current" : "", configured ? "configured" : ""].filter(Boolean).join(" ")}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls="mood-range-editor"
            key={range.id}
            onClick={() => setSelectedRangeId(range.id)}
          >
            <span className="moodScaleDot" aria-hidden="true" />
            <strong>{range.label}</strong>
            <small>{range.min}～{range.max}</small>
          </button>;
        })}
      </div>
    </div>

    <article className="moodRangeEditor" id="mood-range-editor" role="tabpanel">
      <header className="moodRangeEditorHeader">
        <div>
          <span>正在配置</span>
          <h3>{selectedRange.label}</h3>
          <p>心情值 {selectedRange.min}～{selectedRange.max}</p>
        </div>
          <div className="moodRangeBadges" aria-label="当前区间配置状态">
          <span className={source || enterLine ? "ready" : ""}>{source || enterLine ? "已设置进入触发" : "未设置进入触发"}</span>
          <span className={voice ? "ready" : ""}>{voice ? "已设置区间语音" : isCalmRange ? "使用默认参考音频" : "使用语音降级"}</span>
        </div>
      </header>

      <div className="moodRangeEditorBody">
        <section className="moodSettingBlock moodEnterSettingBlock" aria-labelledby="mood-enter-source-title">
          <div className="moodSettingHeading">
            <span className="moodSettingNumber">01</span>
            <div><h4 id="mood-enter-source-title">进入区间时的表现</h4><p>切换到此区间时，可播放动作或表情，并显示一句专属台词。</p></div>
          </div>
          <button
            className="iconButton moodPreviewIcon"
            type="button"
            disabled={!source}
            title={source ? "预览进入表现" : "请先选择动作或表情"}
            aria-label={source ? `预览${selectedRange.label}区间的进入表现` : "预览进入表现，请先选择动作或表情"}
            onClick={() => {
              if (!source) return;
              void window.desktopPet?.mood.previewEnterSource({ petId: pet.id, rangeId: selectedRange.id, source }).then((preview) => {
                if (!preview.ok) setResult({ ok: false, message: preview.message ?? "预览失败。" });
              });
            }}
          ><Play size={17} /></button>
          <label className="moodFieldLabel">动作或表情
            <AppleSelect
              value={sourceValue}
              options={sourceOptions}
              ariaLabel={`${selectedRange.label}进入区间时的表现`}
              onChange={(value) => updateRange(selectedRange.id, { enterSource: value ? pet.expressionSources?.find((item) => `${item.sourceKind}:${item.sourceFileName}:${String(item.runtimeName ?? "")}` === value) : undefined })}
            />
          </label>
          <label className="moodFieldLabel">触发台词
            <input
              className="moodTextField"
              value={enterLine}
              maxLength={300}
              placeholder="例如：我会慢慢平静下来的。"
              onChange={(event) => updateRange(selectedRange.id, { enterLine: event.target.value || undefined })}
            />
          </label>
          {!source && !enterLine ? <p className="moodEmptyHint">未设置时，进入这个区间不会额外播放动作、表情或显示台词。</p> : null}
        </section>

        <section className="moodSettingBlock" aria-labelledby="mood-voice-title">
          <div className="moodSettingHeading">
            <span className="moodSettingNumber">02</span>
            <div><h4 id="mood-voice-title">区间语音参考</h4><p>{isCalmRange ? "未设置时，使用声音模型中配置的默认参考音频。" : "为此心情提供独立参考音频，未设置时会向平静方向降级。"}</p></div>
          </div>
          <div className={voice ? "moodVoiceFile ready" : "moodVoiceFile"}>
            <span aria-hidden="true">{voice ? <Volume2 size={19} /> : <FileAudio size={19} />}</span>
            <div><strong>{voice ? voice.referenceAudio : "尚未添加参考音频"}</strong><small>{voice ? "当前区间将优先使用此音频" : isCalmRange ? "将使用声音模型中的默认参考音频" : "将自动使用最接近平静的可用语音"}</small></div>
            <div className="moodVoiceActions">
              <button className="secondaryAction" type="button" onClick={() => void importVoice(selectedRange.id)}>{voice ? "更换" : "添加音频"}</button>
              {voice ? <button className="iconButton" type="button" title="移除此区间参考音频" aria-label={`移除${selectedRange.label}区间参考音频`} onClick={() => void removeVoice(selectedRange.id)}><Trash2 size={16} /></button> : null}
            </div>
          </div>
          <label className="moodFieldLabel">参考文本
            <textarea className="moodTextField moodReferenceText" rows={2} value={voiceTexts[selectedRange.id] ?? voice?.referenceText ?? ""} maxLength={500} placeholder="填写音频中实际说出的内容" onChange={(event) => {
              const referenceText = event.target.value;
              setVoiceTexts((current) => ({ ...current, [selectedRange.id]: referenceText }));
              setResult(undefined);
              if (voice) updateRange(selectedRange.id, { voiceOverride: { ...voice, referenceText } });
            }} />
          </label>
        </section>
      </div>
    </article>

    {!voiceConnected ? <p className="settingsHint moodConnectionHint"><Volume2 size={16} aria-hidden="true" />声音模型尚未连接。你仍可完成配置，连接声音模型后自动生效。</p> : null}
    <PanelSaveActions onSave={() => void save()} saving={saving} disabled={!dirty} disabledReason={!dirty ? "没有待保存修改" : undefined} result={result} />
  </section>;
}
