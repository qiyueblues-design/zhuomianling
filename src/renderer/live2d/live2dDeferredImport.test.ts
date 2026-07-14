import { describe, expect, it } from "vitest";

describe("Live2D 按需加载模块边界", () => {
  it("Cubism Core 尚未注入时也能载入桌宠详情模块", async () => {
    Reflect.deleteProperty(globalThis, "Live2DCubismCore");

    await expect(import("../components/PetStage/PetStage")).resolves.toMatchObject({
      PetStage: expect.any(Function)
    });
  });
});
