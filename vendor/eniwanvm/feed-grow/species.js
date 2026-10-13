/* 이 파일은 public/eniwanvm/feed-grow/species.js의 사본입니다.
 * 직접 고치지 마세요 — 원본을 고치고 `node tools/build-extension.mjs`를 다시 돌리세요.
 * 두 벌이 갈라지면 대시보드와 확장이 서로 다른 VM으로 돌게 됩니다. */
export const DIET = Object.freeze({ PLANT: 1, MEAT: 2, OMNIVORE: 3 });

// Original assets are deliberately not used. These data define a distinct low-poly reef ecosystem.
export const SPECIES = Object.freeze([
  { id:'silver_fry', name:'은빛 치어', tier:0, size:.42, hp:12, attack:2, speed:10.5, sprint:1.55, turn:4.8, growth:.070, aggression:.05, fear:1.0, diet:DIET.OMNIVORE, depth:[-7,-1], schooling:.95, vision:25, bite:.55, xp:5, color:[.65,.88,1] },
  { id:'reef_grazer', name:'산호 초식어', tier:1, size:.72, hp:25, attack:4, speed:8.4, sprint:1.45, turn:3.7, growth:.060, aggression:.08, fear:.9, diet:DIET.PLANT, depth:[-13,-2], schooling:.8, vision:30, bite:.70, xp:10, color:[.3,1,.65] },
  { id:'dart_snapper', name:'화살퉁돔', tier:2, size:1.05, hp:45, attack:9, speed:9.7, sprint:1.65, turn:3.2, growth:.053, aggression:.65, fear:.65, diet:DIET.MEAT, depth:[-21,-4], schooling:.45, vision:38, bite:.92, xp:19, color:[1,.68,.24] },
  { id:'blue_barracuda', name:'푸른 바라쿠다', tier:3, size:1.55, hp:78, attack:16, speed:11.2, sprint:1.7, turn:2.7, growth:.047, aggression:.82, fear:.42, diet:DIET.MEAT, depth:[-28,-7], schooling:.15, vision:48, bite:1.18, xp:34, color:[.28,.68,1] },
  { id:'stone_grouper', name:'바위 그루퍼', tier:4, size:2.25, hp:150, attack:29, speed:7.6, sprint:1.38, turn:2.0, growth:.042, aggression:.72, fear:.3, diet:DIET.MEAT, depth:[-37,-10], schooling:0, vision:52, bite:1.55, xp:62, color:[.66,.42,.28] },
  { id:'razor_tuna', name:'칼날 참치', tier:5, size:3.15, hp:235, attack:43, speed:12.4, sprint:1.62, turn:1.72, growth:.037, aggression:.78, fear:.2, diet:DIET.MEAT, depth:[-42,-8], schooling:.25, vision:64, bite:1.95, xp:105, color:[.38,.72,.82] },
  { id:'abyss_shark', name:'심연상어', tier:6, size:5.0, hp:460, attack:78, speed:9.5, sprint:1.5, turn:1.18, growth:.032, aggression:.96, fear:.05, diet:DIET.MEAT, depth:[-58,-16], schooling:0, vision:82, bite:2.75, xp:220, color:[.22,.28,.36] },
]);

export const SPECIES_BY_ID = new Map(SPECIES.map((s, i) => [s.id, { ...s, index:i }]));
export const PLAYER_SPECIES = 1;
