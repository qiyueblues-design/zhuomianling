import { Check, Plus, Power } from "lucide-react";
import type { PetDefinition } from "../../../shared/types/pet";
import { hasUsableLive2DModel } from "../../pets/petSources";

interface PetSelectorProps {
  pets: PetDefinition[];
  selectedPetId?: string;
  activePetId?: string;
  onSelectPet: (petId: string) => void;
  onTogglePet: (petId: string) => void | Promise<void>;
  onCreatePet: () => void;
}

export function PetSelector({
  pets,
  selectedPetId,
  activePetId,
  onSelectPet,
  onTogglePet,
  onCreatePet
}: PetSelectorProps): JSX.Element {
  return (
    <section className="selectorPane" aria-label="桌宠列表">
      <div className="selectorSummary" aria-label="桌宠列表操作">
        <span className="countBadge">
          {pets.length ? `${pets.length} 个桌宠` : "0 个桌宠"}
        </span>
      </div>

      <div className="petGrid">
        {pets.map((pet) => {
          const isSelected = pet.id === selectedPetId;
          const isActive = pet.id === activePetId;
          const hasModel = hasUsableLive2DModel(pet);

          return (
            <article
              className={`petCard${isSelected ? " selected" : ""}`}
              key={pet.id}
              onClick={() => onSelectPet(pet.id)}
            >
              <button
                className="petCardButton"
                type="button"
                aria-label={`选择 ${pet.name}`}
                onClick={() => onSelectPet(pet.id)}
              >
                <span className="avatar" aria-hidden="true">
                  {pet.avatarImage ? (
                    <img src={pet.avatarImage} alt="" />
                  ) : (
                    <span>{pet.avatar ?? pet.name.slice(0, 2).toUpperCase()}</span>
                  )}
                </span>
                <span className="petSummary">
                  <span className="petNameRow">
                    <span className="petName">{pet.name}</span>
                  </span>
                  <span className="petMetaRow">
                    <span className="petDescription">{pet.description}</span>
                    {!isActive && !hasModel ? <span className="draftBadge">待导入</span> : null}
                  </span>
                </span>
              </button>

              <div className="petActionStack">
                <button
                  className={isActive ? "activateButton danger" : "activateButton"}
                  type="button"
                  disabled={!hasModel}
                  title={hasModel ? undefined : "请先编辑并导入 Live2D 模型"}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (!hasModel) {
                      return;
                    }
                    void onTogglePet(pet.id);
                  }}
                >
                  <Power size={15} />
                  {isActive ? "关闭桌宠" : hasModel ? "启用" : "待导入"}
                </button>
                {isActive ? (
                  <span className="activeBadge">
                    <Check size={14} />
                    使用中
                  </span>
                ) : null}
              </div>
            </article>
          );
        })}

        {!pets.length ? (
          <div className="emptyPets">
            <strong>暂无桌宠</strong>
            <span>创建后会出现在这里。</span>
          </div>
        ) : null}
      </div>

      <button className="createPetHeroButton" type="button" onClick={onCreatePet}>
        <span className="createPetHeroIcon" aria-hidden="true">
          <Plus size={22} />
        </span>
        <span>
          <strong>创建新桌宠</strong>
        </span>
      </button>
    </section>
  );
}
