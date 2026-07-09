import { useEffect, useState } from "react";
import type { LocalPetSaveResult, PetDefinition } from "../../../shared/types/pet";
import { PanelSaveActions } from "./EditorShared";
import {
  normalizePersonaDraft,
  type PersonaChatLanguage,
  type PersonaReplyLength
} from "./petEditorDrafts";

export function PersonaPanel({
  pet,
  onSavedPet,
  onDirtyChange
}: {
  pet: PetDefinition;
  onSavedPet?: (pet: PetDefinition) => void;
  onDirtyChange: (dirty: boolean) => void;
}): JSX.Element {
  const [personaPrompt, setPersonaPrompt] = useState(pet.personaPrompt);
  const [chatLanguage, setChatLanguage] = useState<PersonaChatLanguage>(
    pet.personaSettings?.chatLanguage ?? "zh"
  );
  const [replyLength, setReplyLength] = useState<PersonaReplyLength | undefined>(
    pet.personaSettings?.replyLength
  );
  const [savedPersonaDraft, setSavedPersonaDraft] = useState<{
    personaPrompt: string;
    chatLanguage: PersonaChatLanguage;
    replyLength?: PersonaReplyLength;
  }>({
    personaPrompt: pet.personaPrompt,
    chatLanguage: pet.personaSettings?.chatLanguage ?? "zh",
    replyLength: pet.personaSettings?.replyLength
  });
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<LocalPetSaveResult | undefined>();

  useEffect(() => {
    const nextDraft = {
      personaPrompt: pet.personaPrompt,
      chatLanguage: pet.personaSettings?.chatLanguage ?? "zh",
      replyLength: pet.personaSettings?.replyLength
    };

    setPersonaPrompt(nextDraft.personaPrompt);
    setChatLanguage(nextDraft.chatLanguage);
    setReplyLength(nextDraft.replyLength);
    setSavedPersonaDraft(nextDraft);
    setResult(undefined);
    onDirtyChange(false);
  }, [onDirtyChange, pet]);

  const updatePersonaDirty = (
    nextDraft: Partial<{
      personaPrompt: string;
      chatLanguage: PersonaChatLanguage;
      replyLength?: PersonaReplyLength;
    }>
  ): void => {
    const mergedDraft = {
      personaPrompt,
      chatLanguage,
      replyLength,
      ...nextDraft
    };

    onDirtyChange(normalizePersonaDraft(mergedDraft) !== normalizePersonaDraft(savedPersonaDraft));
  };

  const savePersona = async (): Promise<void> => {
    if (pet.id === "new-pet") {
      setResult({
        ok: false,
        message: "请先保存基础信息，再编辑角色人设。"
      });
      return;
    }

    setSaving(true);

    try {
      const saveResult = await window.desktopPet?.petConfig.savePersona({
        petId: pet.id,
        personaPrompt,
        chatLanguage,
        replyLength
      });

      if (!saveResult) {
        return;
      }

      setResult(saveResult);

      if (saveResult.ok && saveResult.pet) {
        setSavedPersonaDraft({
          personaPrompt,
          chatLanguage,
          replyLength
        });
        onDirtyChange(false);
        onSavedPet?.(saveResult.pet);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="editorPanel personaEditorPanel">
      <div className="panelTitleRow">
        <div>
          <h2>角色人设</h2>
          <p className="panelSubtleNote">这段内容会作为角色提示词参与对话，用来决定桌宠的性格、说话方式和回应边界。</p>
        </div>
      </div>

      <label className="formField personaPromptField">
        <span>我是谁</span>
        <textarea
          className="personaTextArea"
          rows={16}
          value={personaPrompt}
          onChange={(event) => {
            const nextPersonaPrompt = event.target.value;

            setResult(undefined);
            setPersonaPrompt(nextPersonaPrompt);
            updatePersonaDirty({ personaPrompt: nextPersonaPrompt });
          }}
          placeholder="填写人物性格、说话方式、人生经历、和用户的关系、喜欢或讨厌的事物等等。"
        />
      </label>

      <div className="personaPreferenceGrid">
        <fieldset className="personaLanguagePicker">
          <legend>文字输出语言</legend>
          <div className="personaLanguageOptions">
            {[
              { id: "zh", label: "中文" },
              { id: "ja", label: "日语" },
              { id: "en", label: "英语" }
            ].map((option) => (
              <label className="personaLanguageOption" key={option.id}>
                <input
                  type="radio"
                  name="persona-chat-language"
                  value={option.id}
                  checked={chatLanguage === option.id}
                  onChange={() => {
                    const nextLanguage = option.id as PersonaChatLanguage;

                    setResult(undefined);
                    setChatLanguage(nextLanguage);
                    updatePersonaDirty({ chatLanguage: nextLanguage });
                  }}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
          <p>必选，这是输出到聊天框的语言。</p>
        </fieldset>

        <fieldset className="personaLengthPicker">
          <legend>你希望回复长度</legend>
          <div className="personaLengthOptions">
            {[
              { id: "short", label: "短" },
              { id: "medium", label: "中" },
              { id: "long", label: "长" }
            ].map((option) => (
              <label
                className={replyLength === option.id ? "personaLengthOption active" : "personaLengthOption"}
                key={option.id}
              >
                <input
                  type="checkbox"
                  checked={replyLength === option.id}
                  onChange={() => {
                    setReplyLength((currentLength) => {
                      const nextReplyLength =
                        currentLength === option.id ? undefined : (option.id as PersonaReplyLength);

                      setResult(undefined);
                      updatePersonaDirty({ replyLength: nextReplyLength });

                      return nextReplyLength;
                    });
                  }}
                />
                {option.label}
              </label>
            ))}
          </div>
          <p>可不勾选。</p>
        </fieldset>
      </div>

      <PanelSaveActions
        onSave={() => void savePersona()}
        saving={saving}
        result={result}
        saved={Boolean(result?.ok)}
      />
    </div>
  );
}
