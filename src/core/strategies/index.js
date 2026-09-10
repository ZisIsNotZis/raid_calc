// Strategy implementations. Each strategy provides:
//   placement(totalUsedBytes, memberCapacities) -> [usedBytes per member]
//   lossFraction(lostFlags, memberUsed, totalUsed) -> fraction of used data lost (mode 1, binary members)
//   rebuildRestoresData(params) -> bool  (does a rebuilt member come back with its data?)
//   ioShares(memberUsed, totalUsed, params) -> [{read, write}] share of workload rate per member
// Mode-2 loss weights arrive with ticket 06 (per-span accounting).

const even = (totalUsed, n) => Array.from({ length: n }, () => totalUsed / n);

export const concat = {
  name: "concat",
  symmetricLoss: false, // loss is position-dependent (per-member used shares) — never collapse
  placement(totalUsed, caps) {
    const out = caps.map(() => 0);
    let remaining = totalUsed;
    for (let i = 0; i < caps.length && remaining > 1e-9; i++) {
      const take = Math.min(caps[i], remaining);
      out[i] = take; remaining -= take;
    }
    if (remaining > 1e-6) throw new Error("concat placement overflow: usage exceeds total capacity");
    return out;
  },
  // Fill-first: only members holding data lose anything (frontier member included; members beyond it are empty).
  lossFraction(flags, memberUsed, totalUsed) {
    let lost = 0;
    for (let i = 0; i < flags.length; i++) if (flags[i]) lost += memberUsed[i];
    return totalUsed > 0 ? lost / totalUsed : 0;
  },
  rebuildRestoresData() { return false; }, // no redundancy: rebuilt member comes back empty
  ioShares(memberUsed, totalUsed) {
    return memberUsed.map((u) => ({ read: totalUsed > 0 ? u / totalUsed : 0, write: totalUsed > 0 ? u / totalUsed : 0 }));
  },
};

export const strip = {
  name: "strip",
  symmetricLoss: true,
  // params: {d, m}
  placement(totalUsed, caps, params) {
    const n = params.d + params.m;
    if (caps.length !== n) throw new Error(`strip(${params.d},${params.m}) needs ${n} members`);
    return even(totalUsed, n); // even spread regardless of usage
  },
  lossFraction(flags, _memberUsed, _totalUsed, params) {
    const dead = flags.reduce((a, f) => a + (f ? 1 : 0), 0);
    return dead > params.m ? 1 : 0; // populated stripes span all members: >M dead breaks everything
  },
  rebuildRestoresData(params) { return params.m >= 1; }, // parity reconstructs; RAID0 data is gone
  ioShares(_memberUsed, _totalUsed, params) {
    const n = params.d + params.m;
    return even(1, n).map((s) => ({ read: s, write: s })); // every read/write touches all members
  },
};

export const split = {
  name: "split",
  symmetricLoss: true,
  placement(totalUsed, _caps, params) { return even(totalUsed, params.n + params.m); },
  // Mode 1, coarse chunks: a file is corrupted when >M of its chunks are lost; chunks sit on distinct
  // members round-robin. With members exactly n+m, per-file chunk loss == member loss count.
  lossFraction(flags, _memberUsed, _totalUsed, params) {
    const lost = flags.reduce((a, f) => a + (f ? 1 : 0), 0);
    return lost > params.m ? 1 : 0;
  },
  rebuildRestoresData(_params) { return true; },
  ioShares(_memberUsed, _totalUsed, params) {
    return even(1, params.n + params.m).map((s) => ({ read: s, write: s }));
  },
};

// Ticket 06: strip-split gets its own mode-2 span accounting; mode-1 behavior converges to split.
export const stripSplit = {
  name: "strip-split",
  symmetricLoss: true,
  placement(totalUsed, _caps, params) { return even(totalUsed, params.n + params.m); },
  lossFraction(flags, _memberUsed, _totalUsed, params) {
    const lost = flags.reduce((a, f) => a + (f ? 1 : 0), 0);
    return lost > params.m ? 1 : 0;
  },
  rebuildRestoresData() { return true; },
  ioShares(_memberUsed, _totalUsed, params) {
    return even(1, params.n + params.m).map((s) => ({ read: s, write: s }));
  },
};

export const strategies = { concat, strip, split, "strip-split": stripSplit };
