## Additional Bomb Handling / Arm Control Rules

### Player Presentation

玩家是 2D 俯視角角色。

角色具有兩隻可視化的手臂。

當玩家持有炸彈時：

兩隻手會抓住炸彈。

炸彈不是固定鎖死在角色中心，而是可以由持有者主動控制位置。

---

## Bomb Arm Control

持有炸彈的玩家可以使用滑鼠拖曳手臂，改變炸彈相對於角色的位置。

基本操作概念：

* Mouse position / mouse dragging controls the player's arms
* Arms visually extend toward the controlled bomb position
* Bomb follows the hands
* Bomb remains attached to the holder while being controlled
* Bomb cannot be freely dropped onto the ground

炸彈可以在玩家周圍一定範圍內移動。

請將最大延伸距離參數化：

BombArmReach

炸彈位置不能超過 BombArmReach。

如果滑鼠拖曳超過範圍：

炸彈維持在最大可延伸位置。

---

## Gameplay Purpose of Arm Control

這不是單純的視覺動畫，而是實際 gameplay mechanic。

Bomb Collider 的實際位置會跟著玩家手上的炸彈移動。

因此持有者可以：

* 把炸彈往左或右移動
* 把炸彈縮回身體附近
* 把炸彈伸向外側
* 主動躲避飛來的 projectile
* 主動讓炸彈接住某些 projectile

例如：

敵人射出 -5s projectile。

持有者看到 projectile 後，可以拖動手臂，把炸彈移開，使 projectile 沒有命中 Bomb Collider。

反過來，如果有人射出 +10s Repair projectile，持有者也可以主動把炸彈伸過去接。

---

## Bomb Position Authority

Host authoritative。

Client 可以提交自己的 mouse / arm input。

但最終：

* Bomb position
* Bomb collider position
* Projectile collision
* Item hit result

都必須由 Host 驗證並同步。

不要讓 Client 單方面判定「我躲掉了」或「我命中了」。

---

## Bomb Follow Behavior

炸彈位置由兩部分組成：

Player World Position
+
Arm Controlled Local Offset

角色移動時：

整個可控制炸彈範圍跟著角色移動。

例如玩家向右走：

炸彈也會跟著整體向右移動。

同時玩家仍然可以用滑鼠改變 Local Offset。

---

## Arms

兩隻手臂應該視覺上連接：

Player Body → Hands → Bomb

初版不需要複雜 IK。

可以使用簡單的：

* Rotating arm sprites
* Stretchable arm sprites
* Two-segment visual arms

只要能清楚表達「玩家正在用兩隻手拿著炸彈」即可。

Gameplay collision 只需要以 Bomb Collider 為準。

手臂本身不需要 projectile collision。

---

## Projectile Collision

所有 projectile 都是真實移動的 2D projectile。

Projectile 撞到任何會阻擋它的物件後就消失。

包括：

* Bomb
* Player
* Wall
* Level geometry
* Other blocking objects

如果 projectile 撞到玩家：

Projectile 消失。

但玩家不會受到任何傷害或效果。

如果 projectile 撞到牆壁：

Projectile 消失。

如果 projectile 撞到炸彈：

才執行該 projectile 對炸彈的 gameplay effect。

例如：

* -5s projectile → Bomb Time -5s
* +10s projectile → Bomb Time +10s

因此玩家本體也可以實際站位擋住射向炸彈的 projectile。

---

## Shield Interaction

Shield 仍然只影響 Bomb Collider。

當 Shield Active：

加減秒 projectile 即使命中 Bomb Collider，也不套用時間效果。

Projectile 命中後仍然消失。

Shield 不讓 projectile 穿透。

---

## Card and Coin Cleanup on Death

玩家死亡後：

Coins = 0

Current Cards = empty

所有未使用手牌立即清除。

玩家進入 Spectator Mode。

在該 Match 剩餘時間內：

* Cannot earn coins
* Cannot draw cards
* Cannot use cards
* Cannot interact with bomb
* Cannot block projectiles
* Cannot affect gameplay

下一局 Match 開始時才重新加入。
