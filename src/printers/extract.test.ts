// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { parseConfig } from "../config/ini";
import { extractPrinterMechanics } from "./extract";

const mechanics = (cfg: string) => extractPrinterMechanics(parseConfig(cfg));

describe("extractPrinterMechanics", () => {
  it("lit la cinématique et la course (position_min vaut 0 par défaut)", () => {
    const cfg = `[printer]
kinematics: cartesian
[stepper_x]
position_endstop: 0
position_max: 235
[stepper_y]
position_min: -5
position_max: 230
[stepper_z]
position_max: 250`;
    expect(mechanics(cfg)).toEqual({
      kinematics: "cartesian",
      travel: { minX: 0, maxX: 235, minY: -5, maxY: 230, maxZ: 250 },
    });
  });

  it("ne déduit pas de course X/Y pour une cinématique non rectiligne (delta)", () => {
    const cfg = "[printer]\nkinematics: delta\n[stepper_a]\nposition_endstop: 300";
    expect(mechanics(cfg)).toEqual({ kinematics: "delta" });
  });

  it("lit une sonde active et ignore une sonde en commentaire", () => {
    expect(mechanics("[bltouch]\nsensor_pin: ^PB1\nx_offset: -44\ny_offset: -6")).toEqual({
      probe: { type: "bltouch", xOffset: -44, yOffset: -6 },
    });
    expect(mechanics("#[bltouch]\n#x_offset: -44")).toEqual({});
    expect(mechanics("[probe_eddy_current btt_eddy]\nx_offset: 0\ny_offset: 21.42")).toEqual({
      probe: { type: "probe_eddy_current", xOffset: 0, yOffset: 21.42 },
    });
  });

  it("reconnaît les sondes par la buse (cellule de force, capteurs Creality) sans décalage", () => {
    expect(mechanics("[prtouch_v2]\npr_version: 1\nz_offset: 0")).toEqual({
      probe: { type: "prtouch_v2", xOffset: 0, yOffset: 0 },
    });
    expect(mechanics("[load_cell_probe]\nsensor_type: hx711")).toEqual({
      probe: { type: "load_cell_probe", xOffset: 0, yOffset: 0 },
    });
  });

  it("lit les vis de screws_tilt_adjust (prioritaires) avec leur nom et le filetage", () => {
    const cfg = `[bed_screws]
screw1: 1, 1
[screws_tilt_adjust]
screw1: -5, 30
screw1_name: avant gauche
screw2: 155, 30
screw_thread: CW-M4`;
    expect(mechanics(cfg).screws).toEqual({
      source: "screws_tilt_adjust",
      thread: "CW-M4",
      points: [
        { x: -5, y: 30, name: "avant gauche" },
        { x: 155, y: 30 },
      ],
    });
  });

  it("s'arrête au premier numéro de vis manquant, comme Klipper", () => {
    const cfg = "[bed_screws]\nscrew1: 33,29\nscrew2: 273,29\nscrew4: 33,269";
    expect(mechanics(cfg).screws?.points).toHaveLength(2);
  });

  it("ignore une section de vis sans vis exploitable", () => {
    expect(mechanics("[bed_screws]\nscrew1: abc").screws).toBeUndefined();
  });

  it("lit les réglages de maillage (probe_count simple ou double)", () => {
    expect(
      mechanics("[bed_mesh]\nmesh_min: 30, 30\nmesh_max: 200,200\nprobe_count: 5").mesh,
    ).toEqual({
      min: [30, 30],
      max: [200, 200],
      probeCount: [5, 5],
    });
    expect(mechanics("[bed_mesh]\nprobe_count: 7, 3").mesh).toEqual({ probeCount: [7, 3] });
  });

  it("lit les réglages d'un plateau rond", () => {
    expect(
      mechanics("[bed_mesh]\nmesh_radius: 100\nmesh_origin: 0, 10\nround_probe_count: 7").mesh,
    ).toEqual({ radius: 100, origin: [0, 10], roundProbeCount: 7 });
  });

  it("ignore une course incomplète", () => {
    expect(
      mechanics("[printer]\nkinematics: corexy\n[stepper_x]\nposition_max: 350").travel,
    ).toBeUndefined();
  });
});
