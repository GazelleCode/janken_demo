# JANKEN TIMING TEST

スマートフォンのブラウザカメラに映る二人の手について、グー・チョキ・パーが**安定して確定した最初の映像フレーム**を記録し、PLAYER Bの時刻 − PLAYER Aの時刻をミリ秒で表示する技術検証用Webアプリです。

これは「じゃんけんVAR」の基礎検証です。映像や手のランドマークはサーバーに送信・保存せず、MediaPipe Tasks Visionの推論をブラウザ内だけで行います。

> 現時点では、意図的な後出しかどうか、じゃんけんの勝敗、反則の自動認定は判定しません。

## 使い方

1. スマートフォンでGitHub PagesのHTTPS URLを開きます。
2. `ENABLE CAMERA` を押し、前面カメラの権限を許可します。
3. 二人が画面中央の線を挟み、PLAYER Aを画面左、PLAYER Bを画面右に配置します。利き手・左右の手は問いません。**画面上の手首位置**だけでA/Bを割り当てます。
4. `START TEST` を押します。`3 → 2 → 1 → GO!` の後、各プレイヤーが最初に3フレーム連続で認識されたグー・チョキ・パーを記録します。
5. 両方が確定すると、確定時刻と `B - A` の時間差、遅かったプレイヤーを表示します。`RESET` で何度でも測定できます。

認識対象はMediaPipe Gesture Recognizerの `Closed_Fist → ROCK`、`Victory → SCISSORS`、`Open_Palm → PAPER` です。その他、またはconfidenceが0.70未満の認識は `UNKNOWN` としてタイミング判定から除外します。しきい値と連続フレーム数は [`app.js`](app.js) 冒頭の定数で調整できます。

## GitHub Pagesで公開する

1. GitHubリポジトリの **Settings → Pages** を開きます。
2. **Build and deployment** の Source を **Deploy from a branch** にします。
3. 公開ブランチ（通常は `main`）とフォルダ **/(root)** を選び、保存します。
4. 数分後、表示された `https://<account>.github.io/<repository>/` をスマートフォンのブラウザで開きます。

`getUserMedia()` はHTTPS（またはlocalhost）でのみ動作するため、ローカルのファイルを直接開かず、GitHub PagesのURLを使ってください。

## 使用技術

- HTML / CSS / JavaScriptのみの静的Webアプリ
- [MediaPipe Tasks Vision Gesture Recognizer](https://ai.google.dev/edge/mediapipe/solutions/vision/gesture_recognizer/web_js)
- `getUserMedia()` による端末カメラ取得
- `requestVideoFrameCallback()` による映像フレーム単位の推論（非対応ブラウザでは`requestAnimationFrame()`へフォールバック）

MediaPipeのWASMランタイムと公式Gesture Recognizerモデルは初回読み込み時にCDNから取得しますが、カメラ画像・映像・ランドマーク・測定結果を外部へ送信する処理はありません。推論はすべて端末内です。

## 時間分解能について

表示するタイムスタンプは、`GO!` 後に同じジェスチャーが3フレーム連続で認識された場合の**最初のフレーム**です。3フレーム目の時刻にはしません。

ただし、時間の分解能はカメラフレームレートに制限されます。30fpsではフレーム間隔はおよそ33.3ms、60fpsではおよそ16.7msです。そのため10ms程度の差を正確に直接測定できるとは限りません。画面上の `Camera FPS`（端末報告値）、`Measured FPS`、`Approx. frame interval` を必ず確認し、表示上の小数点を過剰な精度として解釈しないでください。

## デバッグ

`DEBUG MODE` を有効にすると、カメラ上に21個の手のランドマークを描画し、折りたたみログに各フレームの以下を表示します。

- 21ランドマーク座標
- 手首の画面上x座標
- PLAYER A/B割り当て
- 元のGesture Recognizer分類、変換後ジェスチャー、confidence
- フレームtimestamp
- 同一ジェスチャーの連続認識数

## 検証時の推奨

- 縦向きのスマートフォンで、明るく背景が単純な場所を使ってください。
- 二人の手が中央線をまたがず、それぞれ十分に画面内へ入るようにしてください。
- 手の形を一瞬で動かし続けず、少なくとも3カメラフレーム安定させてください。
- 端末・ブラウザ・照明・手の向きによってGesture Recognizerの精度と実効fpsは変わります。DEBUG MODEで実際の割り当てと連続フレーム数を確認してください。
