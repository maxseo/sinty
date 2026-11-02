/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AdjustmentLayer, Geometry, Group, Scene, Source, getActiveEntity } from "@diffusionstudio/runtime";
import { parseSource } from "@diffusionstudio/jsx";
import { DapiError } from "@diffusionstudio/dapi";

import type { Entity, World } from "koota";

// Scenes are nodes too, so node-targeting tools accept them alongside
// geometry, groups, and adjustment layers.
export function isNode(entity: Entity): boolean {
  return entity.has(Geometry)
    || entity.has(Group)
    || entity.has(AdjustmentLayer)
    || entity.has(Scene);
}

/** The one node an id names, or the error that says why there is not exactly one. An empty id, or the words stage/scene/active, means the scene that is open. */
export function resolveNode(world: World, id?: string): Entity {
  const wanted = typeof id === "string" ? id.trim() : "";
  if (!wanted || wanted === "stage" || wanted === "scene" || wanted === "active") {
    const active = getActiveEntity(world);
    if (active && isNode(active)) return active;
    const scenes = world.query(Scene).filter((entity) => isNode(entity));
    if (scenes.length === 1) return scenes[0]!;
    throw new DapiError("not-found", "Нет открытой сцены. Вызовите context и возьмите id сцены оттуда.");
  }
  const matches = world.query(Source).filter((entity) => {
    const stamp = entity.get(Source)!.value;
    if (stamp === wanted) return true;
    const parsed = parseSource(stamp);
    return parsed !== undefined && String(parsed.locator) === wanted;
  });
  if (!matches.length) {
    throw new DapiError("not-found", `No such node: "${wanted}" — id сцены или клипа берётся из context (например index.tsx:2)`);
  }

  const nodes = matches.filter(isNode);
  if (!nodes.length) {
    throw new DapiError("wrong-kind", `"${wanted}" is not a node; target a scene, group, clip, or adjustment layer`);
  }
  if (nodes.length > 1) {
    const stamps = [...new Set(nodes.map((node) => node.get(Source)!.value))];
    if (stamps.length === 1) {
      // One element, many entities: a loop renders its body once per item.
      throw new DapiError("ambiguous", `"${wanted}" renders ${nodes.length} times (it sits in a loop) — target its scene instead`);
    }
    throw new DapiError(
      "ambiguous",
      `"${wanted}" is ambiguous between ${stamps.map((stamp) => `"${stamp}"`).join(", ")} — use the file:id form`,
    );
  }
  return nodes[0]!;
}
