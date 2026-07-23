# Multiplayer Bomb Passing PvP Prototype

請製作一個最小可玩的 **2D 俯視角多人連線 PvP prototype**。

遊戲的核心概念類似一群人圍桌進行危險遊戲。

**所有玩家角色從遊戲開始到結束都固定坐在自己的座位上，不能自由移動，就像 Liar's Bar 的玩家一樣。**

玩家的主要操作不是走路，而是：

* 傳遞炸彈
* 操作手臂移動手上的炸彈
* 賺取金幣
* 花金幣抽卡
* 使用手牌中的卡片
* 射擊 / 投擲 projectile
* 利用資訊差與炸彈時間互相陷害

不要自行增加未描述的玩法，例如：

* HP
* 普通攻擊
* 角色移動
* 跳躍
* 技能樹
* 職業系統
* 額外戰鬥機制
* 地圖探索
* 場景機關

所有重要 gameplay 數值都必須集中成可調參數，不要 hardcode。

---

# Core Match Flow

每一整局 Match 的目標：

**成為最後一名存活玩家。**

核心流程：

Bomb Spawn
→ Initial Time Reveal
→ 3 Second Countdown
→ Hide Bomb Timer
→ Random Initial Holder
→ Bomb Passing / Card Gameplay
→ Bomb Explodes
→ Current Holder Eliminated
→ Next Bomb
→ Repeat
→ Last Survivor Wins

---

# Player Seating / Layout

遊戲為 **2D Top-Down**。

所有玩家固定坐在一張桌子或圓形遊戲區域周圍。

例如：

A → B → C → D → E → F

玩家有固定座位。

整局遊戲期間：

* 玩家不能離開座位
* 玩家不能走路
* 玩家不能改變自己的 world position
* 玩家不能靠角色移動來閃避 projectile
* 玩家只能透過操作手臂與炸彈改變炸彈的位置

角色可以有動畫，例如：

* 手臂動作
* 使用卡片
* 射擊
* 投擲
* 被炸死
* 表情或反應

但是角色本體位置固定。

---

# Multiplayer Authority

遊戲採：

**Host Authoritative**

以下 gameplay state 全部由 Host 決定：

* Bomb remaining time
* Bomb initial time
* Bomb holder
* Bomb position
* Bomb collider position
* Bomb speed multiplier
* Bomb effects
* Projectile state
* Projectile collision
* Item hit result
* Player death
* Coins
* Card draw
* Cards / inventory
* Pass lock
* Shield
* Curse
* Alive / Dead / Spectator state

Client 可以傳送：

* Input
* Mouse position
* Arm control input
* Card usage request
* Pass request
* Shooting direction

但 Client 不可以自行決定：

* Projectile 是否命中
* Bomb Time 改變
* Bomb 爆炸
* 玩家死亡
* 抽到哪張卡

---

# Bomb Time Pool

Lobby 中 Host 可以設定：

**Bomb Time Pool**

例如：

* 60 seconds
* 90 seconds
* 120 seconds

Host 可以勾選哪些時間加入 Pool。

例如：

BombTimePool = [60, 90, 120]

每次生成新炸彈時：

Host 從 Bomb Time Pool 隨機抽取一個值。

例如抽到：

90 Seconds

---

# Bomb Introduction

每一顆新炸彈開始之前：

所有玩家都可以看到：

**BOMB TIME: 90 SECONDS**

接著開始：

3
2
1

倒數結束後：

* Bomb Remaining Time 開始正式倒數
* Remaining Time 從一般 UI 隱藏
* 隨機選擇一名存活玩家作為 Initial Holder
* Gameplay 正式開始

玩家只知道：

這顆炸彈「一開始」有多少秒。

之後無法直接知道目前剩餘時間。

---

# Hidden Bomb Timer

Bomb Remaining Time 在正常情況下：

**不可以顯示給玩家。**

玩家只能靠：

* 自己記時間
* 觀察炸彈傳遞
* 記住 +Time / -Time
* 記住 Speed Up / Slow Down
* 使用 Magnifying Glass

來推測剩餘時間。

---

# Default Bomb Passing Order

所有存活玩家依照固定座位順序傳炸彈。

例如：

A → B → C → D → A

Current Holder 預設只能傳給：

**Next Alive Player In Order**

例如 C 已死亡：

A → B → D → A

死亡玩家會直接被跳過。

一般傳遞：

不需要選擇目標。

玩家只要按下 Pass：

炸彈自動傳給下一名存活玩家。

---

# Future Targeted Passing Cards

某些未來或特殊 Card 可以修改傳遞規則，例如：

**直接把炸彈傳給指定玩家。**

但這不是角色的預設能力。

沒有對應 Card 時：

玩家只能按照固定順序傳。

---

# Minimum Hold Time

每次玩家收到炸彈後：

需要至少持有一段時間才能再次傳遞。

參數：

BaseMinimumHoldTime = 1.0 seconds

必須參數化。

收到炸彈時：

PassLockRemainingTime = BaseMinimumHoldTime

期間禁止 Pass。

UI 顯示：

PASS LOCK: 0.8s

倒數完成後：

CAN PASS

---

# Bomb Explosion

Bomb Remaining Time 正常倒數至：

0

時立即爆炸。

目前 Bomb Holder：

立即死亡。

玩家唯一的死亡方式就是：

**持有炸彈時炸彈自然倒數至 0。**

遊戲沒有 HP。

---

# Bomb Time Reduction Safety Rule

任何 **-Time Card** 都不能直接利用瞬間扣秒讓炸彈當場爆炸。

參數：

MinimumBombTimeAfterReduction = 1.0 second

例如：

Current Bomb Time = 3s

命中：

-5s

結果：

Bomb Time = 1s

而不是：

0s

因此：

Time Reduction Formula：

BombTime = max(
BombTime - ReductionAmount,
MinimumBombTimeAfterReduction
)

但是：

正常時間流逝仍然可以：

1.0 → 0.9 → ... → 0

並爆炸。

---

# Bomb Time Upper Limit

Bomb Time：

**沒有上限。**

例如：

Initial Bomb Time = 60s

經過大量 Repair：

Bomb Time 可以成為：

70s
90s
120s
150s

不需要限制回 Initial Time。

---

# Bomb Speed

正常：

BombSpeedMultiplier = 1.0

Bomb Timer 每秒：

減少 1 秒。

---

# Speed Up Card

使用後：

BombSpeedMultiplier = 2.0

參數：

FastBombMultiplier = 2.0

持續：

FastBombDuration = 4.0 seconds

因此：

現實經過 4 秒

炸彈實際經過約：

8 秒

---

# Slow Down Card

使用後：

BombSpeedMultiplier = 0.5

參數：

SlowBombMultiplier = 0.5

持續：

SlowBombDuration = 4.0 seconds

因此：

現實經過 4 秒

炸彈實際只經過：

2 秒

---

# Speed Modifier Override Rule

Speed Up 與 Slow Down：

**不能疊加。**

新的 Speed Modifier：

直接覆蓋舊的效果。

例如：

目前：

Speed = 2x
Duration Remaining = 2s

有人使用 Slow Down：

立即改成：

Speed = 0.5x
Duration = SlowBombDuration

舊效果直接消失。

不要做：

2 × 0.5

不要疊加 Duration。

---

# Coin Economy

金幣：

只允許整數。

不能有小數。

---

# Passive Income

所有存活玩家：

固定每 N 秒獲得金幣。

參數：

PassiveCoinInterval
PassiveCoinAmount

例如：

PassiveCoinInterval = 3s
PassiveCoinAmount = 1

---

# Bomb Holder Income

目前持有炸彈的玩家：

會獲得額外收入。

參數：

BombHolderCoinInterval
BombHolderCoinAmount

例如：

BombHolderCoinInterval = 1s
BombHolderCoinAmount = 1

Bomb Holder：

仍然會同時獲得 Passive Income。

所以炸彈持有者：

Passive Income
+

Holder Bonus Income

同時存在。

這是主要的：

**Risk vs Reward**

持有炸彈越久：

賺得越多。

但是也越可能爆炸。

---

# Starting Coins

整局 Match 開始時：

Coins = StartingCoins

預設：

StartingCoins = 0

但必須參數化。

---

# Card Economy — Very Important

**所有特殊道具全部都是 Card。**

遊戲不存在免費道具。

遊戲不存在角色預設特殊能力。

以下所有東西都必須先透過花金幣抽卡取得：

* Magnifying Glass
* -1s Gun
* -3s Gun
* -5s Gun
* +5s Repair Kit
* +10s Repair Kit
* Speed Up Stopwatch
* Slow Down Stopwatch
* Shield
* Curse
* 未來其他特殊道具

基本流程永遠是：

Earn Coins
→ Spend Coins
→ Draw Random Card
→ Card Enters Hand
→ Use Card
→ Consume Card

---

# Card Draw

玩家只要：

* Alive
* Coins 足夠
* Hand 未滿

就可以：

**隨時抽卡。**

包括：

* 沒拿炸彈時
* 正在拿炸彈時

不需要等待特殊 Phase。

---

# Card Draw Cost

參數：

CardDrawCost

玩家按 Draw 時：

Host 檢查 Coins。

若：

Coins >= CardDrawCost

並且：

CurrentHandSize < MaxHandSize

則：

1. 扣除 CardDrawCost
2. Host 進行 Random Card Draw
3. Card 加入 Hand
4. 更新 UI

---

# Hand Limit

參數：

MaxHandSize = 3

必須參數化。

玩家最多同時保留：

3 張 Card。

如果：

HandSize >= MaxHandSize

不能抽卡。

而且：

不扣錢。

---

# Card Consumption

所有 Card 預設：

**Single Use**

使用成功啟動後：

Card 從 Hand 移除。

若是 Projectile Card：

即使射偏：

Card 仍然消耗。

不能射完沒命中就把 Card 退回。

---

# Card Drop Pool

初版 Card Pool：

* Magnifying Glass
* -1s Gun
* -3s Gun
* -5s Gun
* +5s Repair Kit
* +10s Repair Kit
* Speed Up Stopwatch
* Slow Down Stopwatch
* Shield
* Curse

每張 Card：

具有獨立：

CardDropWeight

Drop Weight 全部參數化。

初版數值可以自行設定合理值。

目前不需要特別平衡。

---

# Magnifying Glass Card

任何存活玩家：

只要 Hand 中有 Magnifying Glass

即可使用。

使用後：

Card 消耗。

參數：

RevealDuration = 3.0 seconds

只有使用者本人可以看到：

Current Bomb Remaining Time

例如：

Bomb: 18.4
Bomb: 18.3
Bomb: 18.2

持續即時更新。

其他玩家：

完全看不到。

---

# Minus-Time Gun Cards

共有：

* -1s Gun
* -3s Gun
* -5s Gun

任何存活玩家：

只要抽到對應 Card

都可以使用。

使用後：

玩家進行一次 Projectile Shooting Action。

---

# Gun Projectile

不是 hitscan。

必須是真實移動的：

2D Projectile。

Projectile 從玩家座位 / 手部 / 武器位置發射。

朝玩家指定方向飛行。

只有命中：

Bomb Collider

才會套用減秒效果。

---

# Repair Kit Cards

共有：

* +5s Repair Kit
* +10s Repair Kit

任何存活玩家：

只要 Hand 中有對應 Card

即可使用。

使用後：

產生一個真實移動的 2D Projectile。

可以理解成：

玩家把 Repair Kit 投擲出去。

只有命中：

Bomb Collider

才會增加 Bomb Time。

---

# Public Time Modification Feedback

任何 Bomb Time Modifier 成功命中時：

所有玩家都必須知道：

改變了多少時間。

例如：

-1 SEC

-3 SEC

-5 SEC

+5 SEC

+10 SEC

但是：

**不能公開目前炸彈剩餘幾秒。**

---

# Shield Card

只有：

**Current Bomb Holder**

可以使用 Shield。

而且必須：

Hand 中確實持有 Shield Card。

如果不是 Bomb Holder：

Shield Card 不可使用。

Card 留在 Hand 中。

---

# Shield Duration

參數：

ShieldDuration = 5.0 seconds

使用後：

Shield Card 消耗。

炸彈獲得 Shield。

Shield 只阻擋：

* Minus-Time Projectile
* Plus-Time Projectile

---

# Shield Does NOT Block

Shield 不阻擋：

* Speed Up
* Slow Down
* Magnifying Glass
* Curse
* Bomb Passing
* Natural Bomb Countdown

Shield：

不是玩家無敵。

只是保護炸彈免受：

+Time / -Time Projectile

影響。

---

# Shield Projectile Interaction

Shield Active 時：

Projectile 命中 Bomb Collider。

Projectile：

仍然立即消失。

但：

不套用 +Time / -Time Effect。

---

# Curse Card

Curse 是一張 Card。

使用者必須：

先抽到 Curse。

使用後：

Curse Card 消耗。

Curse 附著到目前炸彈。

---

# Curse Trigger

Curse：

不會影響 Current Holder。

而是等待：

**下一次 Bomb Ownership Transfer。**

例如：

A 現在拿炸彈。

B 使用 Curse。

炸彈獲得：

CurseActive = True

A 傳給 C。

C 收到炸彈時：

Minimum Hold Time 改成：

CurseMinimumHoldTime = 5.0 seconds

必須參數化。

之後：

Curse 被消耗。

CurseActive = False

C 必須持有 5 秒之後：

才能再次 Pass。

---

# Player Presentation

每名玩家是一個：

2D Top-Down Character

固定坐在自己的座位上。

角色本體不可移動。

玩家具有：

兩隻可視化的手臂。

---

# Bomb Holder Presentation

當玩家持有炸彈時：

角色會用：

**兩隻手抓住炸彈。**

炸彈不是固定貼在角色中心。

持有者可以使用滑鼠：

控制雙手與炸彈的位置。

---

# Bomb Arm Control

持有炸彈的玩家可以：

使用滑鼠拖曳炸彈 / 手臂。

炸彈可以在角色座位周圍一定範圍內移動。

玩家角色本體：

完全不移動。

只有：

手臂與炸彈移動。

---

# Bomb Arm Reach

參數：

BombArmReach

Bomb Position 必須限制在：

角色座位中心附近一定半徑。

Concept：

BombPosition =
PlayerSeatPosition
+
ArmControlledOffset

並且：

length(ArmControlledOffset) <= BombArmReach

如果 Mouse 超過範圍：

炸彈停留在最大 Reach 上。

---

# Bomb Cannot Be Dropped

炸彈持有期間：

炸彈永遠保持：

Attached To Holder

不能：

* 丟在地上
* 放在桌上不管
* 自由掉落
* 脫離目前 Holder

除非：

玩家進行正式 Bomb Pass。

---

# Arm Visuals

雙手必須視覺上：

Player Body
→ Arms
→ Hands
→ Bomb

初版不需要複雜 IK。

可以使用簡單：

* Rotating Arm Sprites
* Stretching Arms
* Two-Segment Arms

Gameplay 最重要的是：

Bomb Collider 的位置真的會隨手臂移動。

---

# Gameplay Purpose of Bomb Arm Movement

手臂控制不是單純動畫。

它是重要 Gameplay Mechanic。

因為：

Bomb Collider 的位置真的會改變。

持有者可以利用滑鼠：

* 把炸彈往左移
* 往右移
* 往桌子中央伸
* 縮回自己身體附近
* 閃避 Minus-Time Projectile
* 閃避 Plus-Time Projectile
* 主動用炸彈去接有利的 Repair Projectile

例如：

有人射出：

-5s Projectile

Holder 可以快速把炸彈拖往另一側。

Projectile 如果沒有撞到 Bomb Collider：

就不生效。

---

# Bomb Position Authority

Bomb Arm Input：

由 Holder Client 提供。

例如：

Mouse Position
Desired Bomb Offset

但 Host：

決定最終 Bomb Position。

Host 驗證：

BombArmReach

並同步：

* Bomb Position
* Bomb Collider
* Arm Visual State

---

# Projectile Rules

所有射擊 / 投擲型 Card：

全部使用真正的 2D Projectile。

不要使用 hitscan。

---

# Projectile Blocking

Projectile 撞到 Blocking Collider 後：

立即消失。

Blocking Collider 包括：

* Bomb
* Player Body
* Wall
* Table / Level Geometry
* Other Blocking Object

---

# Projectile Hits Player

Projectile 命中玩家本體：

Projectile 消失。

但：

玩家不受到任何傷害。

不扣 HP。

不暈眩。

不產生 Gameplay Effect。

---

# Player Body Can Block Projectiles

因為所有玩家固定坐在座位上：

Player Body 本身可以成為射線路徑上的阻擋物。

因此玩家射擊角度與炸彈位置會影響：

Projectile 能否成功命中炸彈。

例如：

炸彈 Holder 可以把炸彈縮到自己身體另一側。

敵人的 Projectile：

可能先撞到 Player Body

並消失。

因此：

Bomb Arm Positioning 是防禦技巧的一部分。

---

# Arms Collision

手臂本身：

不需要阻擋 Projectile。

Projectile collision 主要使用：

* Player Body Collider
* Bomb Collider
* Environment Collider

---

# Bomb Collider

炸彈具有：

獨立 Collider。

不與 Player Collider 共用。

Bomb Collider：

跟著玩家手臂控制的位置移動。

只有：

Projectile 真正碰到 Bomb Collider

才算：

Hit Bomb。

---

# Player Damage

遊戲：

沒有 HP 系統。

任何 Projectile：

都不能殺玩家。

玩家唯一死亡條件：

Bomb Timer 正常倒數到 0 時：

Current Holder 被炸死。

---

# Player Death

炸彈爆炸後：

Current Holder：

立即 Eliminated。

角色可以播放：

Explosion / Death Animation

之後：

角色從 Gameplay 中消失。

---

# Death Cleanup

死亡玩家：

Coins = 0

Hand = Empty

所有未使用 Cards：

全部清除。

---

# Spectator Mode

死亡玩家：

進入 Spectator Mode。

直到下一整局 Match。

Spectator：

* Cannot earn coins
* Cannot draw cards
* Cannot use cards
* Cannot block projectiles
* Cannot interact with bomb
* Cannot affect gameplay

可以觀看：

剩餘玩家進行遊戲。

---

# After Each Explosion

當炸彈爆炸：

1. Current Holder dies
2. Current Holder enters Spectator Mode
3. Bomb entity destroyed
4. Short transition
5. New Bomb Spawn
6. Random Initial Bomb Time From Lobby Pool
7. Reveal Initial Time
8. 3 / 2 / 1
9. Random Alive Player becomes Initial Holder
10. Continue Game

---

# New Bomb Reset

每顆新炸彈生成時：

全部 Bomb-specific temporary state 重置。

包括：

* Bomb Remaining Time
* Speed Modifier
* Shield
* Curse
* Magnifying Glass Reveal
* Pass Lock
* Temporary Bomb Effects

但是：

**存活玩家保留：**

* Coins
* Cards

所以經濟與手牌：

會跨越多顆炸彈。

---

# Match End

當：

AlivePlayerCount == 1

最後一名玩家：

獲勝。

整局 Match 結束。

---

# Full Match Reset

下一整局開始時：

所有玩家重新加入。

全部：

* Respawn
* Return to original seats
* Coins reset to StartingCoins
* Cards reset
* Hand empty
* Alive state reset
* Spectator state reset
* Bomb state reset

---

# UI

正常 Gameplay UI 至少顯示：

* Alive Players
* Coins
* Current Cards
* Current Bomb Holder
* Pass Lock / Can Pass
* Draw Card Button / Input
* Card Slots
* Public Gameplay Events

---

# Card UI

玩家需要可以看到自己的：

3 個 Hand Slots。

例如：

Slot 1
Slot 2
Slot 3

Card UI 必須清楚顯示：

* Card Type
* Card Value，例如 -5s / +10s
* 是否可使用

---

# Public Gameplay Events

所有玩家都可以看到：

* -1s
* -3s
* -5s
* +5s
* +10s
* Speed ×2
* Speed ×0.5
* Shield Activated
* Curse Activated
* Card Draw / Usage 可以適度顯示

但是：

不能顯示：

Current Bomb Remaining Time

---

# Pass UI

只有 Current Holder 需要操作 Pass。

收到 Bomb 時：

顯示：

PASS LOCK: X.Xs

完成後：

顯示：

PASS

按下：

直接傳給固定順序中的：

Next Alive Player。

---

# Debug Mode

請提供可以 Toggle 的：

Debug UI

顯示：

* Exact Bomb Remaining Time
* Bomb Initial Time
* Current Bomb Holder
* Bomb World Position
* Current Arm Offset
* Bomb Speed Multiplier
* Speed Modifier Remaining Duration
* Shield Active
* Shield Remaining Duration
* Curse Active
* Current Minimum Hold Time
* Pass Lock Remaining Time
* Every Player's Coins
* Every Player's Hand
* Alive / Dead / Spectator
* Current Passing Order
* Next Alive Player
* Host / Client Ownership
* Projectile State
* Projectile Hit Result

Debug UI：

只用於開發測試。

正式 Gameplay UI 不顯示上述隱藏資訊。

---

# Important Design Constraints

請特別遵守：

### 1. Players Cannot Move

所有玩家全程固定坐在原始座位。

這是一個像 **Liar's Bar** 一樣：

「玩家坐在桌邊互相進行心理博弈」

的遊戲。

不要做 WASD movement。

不要做 walking system。

不要做 free roaming。

---

### 2. Only Arms and Bomb Move

Holder 的主要物理操作：

是使用 Mouse 控制：

**雙手 + 炸彈**

不是移動角色。

---

### 3. Every Special Item Is A Card

Magnifying Glass、Gun、Repair Kit、Stopwatch、Shield、Curse：

全部必須透過：

Coins → Random Draw

取得。

沒有免費使用。

---

### 4. Cards Are Consumables

使用後：

消耗。

Projectile 射偏：

也照樣消耗。

---

### 5. No Additional Combat System

不要做：

HP
Damage
Melee Attack
Character Combat
Knockback
Stun

---

### 6. Focus On The Bomb

所有 Gameplay 都應該圍繞：

* Bomb Time
* Bomb Information
* Bomb Passing
* Bomb Position
* Bomb Projectile Interaction
* Risk / Reward Economy

---

# Development Priority

第一版優先確認：

1. Multiplayer synchronization
2. Fixed seat player layout
3. Host authoritative bomb timer
4. Bomb ownership
5. Hidden timer
6. Passing order
7. Minimum hold time
8. Arm-controlled bomb movement
9. Projectile collision
10. Coin economy
11. Random card draw
12. Three-card hand
13. Card usage / consumption
14. Bomb time modification
15. Speed modifiers
16. Shield
17. Curse
18. Player elimination
19. Spectator flow
20. Match reset

第一版重點：

**Gameplay prototype correctness > Art / Polish**

不要自行擴充額外玩法。
