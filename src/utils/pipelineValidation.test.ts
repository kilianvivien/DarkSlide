import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FILM_PROFILES } from '../constants';
import { deltaE, srgbToLab } from './colorScience';
import { processImageData } from './imagePipeline';

interface ReferencePatch {
  name: string;
  x: number;
  y: number;
  source: [number, number, number];
  expected: [number, number, number];
}

interface ReferenceFixture {
  profile: string;
  patches: ReferencePatch[];
}

function loadFixtures() {
  const fixtureDir = path.resolve(process.cwd(), 'src/test/fixtures/reference');
  return readdirSync(fixtureDir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(readFileSync(path.join(fixtureDir, file), 'utf8')) as ReferenceFixture);
}

function buildFixtureImage(patches: ReferencePatch[]) {
  const width = Math.max(...patches.map((patch) => patch.x)) + 1;
  const height = Math.max(...patches.map((patch) => patch.y)) + 1;
  const data = new Uint8ClampedArray(width * height * 4);

  for (const patch of patches) {
    const index = (patch.y * width + patch.x) * 4;
    data[index] = patch.source[0];
    data[index + 1] = patch.source[1];
    data[index + 2] = patch.source[2];
    data[index + 3] = 255;
  }

  return new ImageData(data, width, height);
}

describe('pipeline validation corpus', () => {
  const fixtures = loadFixtures();

  for (const fixture of fixtures) {
    it(`${fixture.profile} stays within the synthetic reference threshold`, () => {
      const profile = FILM_PROFILES.find((candidate) => candidate.id === fixture.profile);
      expect(profile).toBeTruthy();
      if (!profile) {
        return;
      }

      const imageData = buildFixtureImage(fixture.patches);
      processImageData(
        imageData,
        profile.defaultSettings,
        profile.type === 'color',
        'processed',
        profile.maskTuning,
        profile.colorMatrix,
        profile.tonalCharacter,
      );

      const patchDiffs = fixture.patches.map((patch) => {
        const index = (patch.y * imageData.width + patch.x) * 4;
        const actual: [number, number, number] = [
          imageData.data[index],
          imageData.data[index + 1],
          imageData.data[index + 2],
        ];

        return {
          name: patch.name,
          delta: deltaE(srgbToLab(...actual), srgbToLab(...patch.expected)),
        };
      });

      const meanDeltaE = patchDiffs.reduce((sum, patch) => sum + patch.delta, 0) / patchDiffs.length;
      if (meanDeltaE >= 10) {
        throw new Error(`${fixture.profile} mean deltaE ${meanDeltaE.toFixed(2)} exceeded threshold: ${JSON.stringify(patchDiffs)}`);
      }

      expect(meanDeltaE).toBeLessThan(10);
    });
  }
});
