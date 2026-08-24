# supercode.token-usage

TUI-плагин OpenCode: складная секция `Token Usage` в сайдбаре сессии — накопленный
расход текущей сессии по данным `step-finish`-частей ассистентских сообщений:

```text
▾ Token Usage
  Input                 20,815
  Output                    11
  Reasoning                  3
  Cache read                 0
  Cache write                0
  Cache rate              0.0%
  Cost                    $0.00
```

Один входной файл `src/usage-panel.tsx` (View + регистрация слота), вся логика — в
`src/usage-model.ts`. Без сборки: рантайм 1.18.21 транспилирует `.tsx` на лету.

## Как работает

1. **Usage Model** (`usage-model.ts`) — единственный шов с логикой: свёртка
   `step-finish`-частей (не поле `tokens` сообщения — это снимок последнего шага) в
   итоги сессии; вклад группируется по паре `(providerID, modelID)` под будущую
   per-model разбивку; все формулы и всё форматирование живут здесь же.
   `Cache rate = read / (input + read + write)` — при нулевом знаменателе прочерк;
   недоступное значение — тоже прочерк, никогда `NaN`/ноль-как-факт.
2. **View** (`usage-panel.tsx`) — только JSX: заголовок со стрелкой (клик сворачивает,
   по умолчанию развёрнуто), строки `label ⟷ value`, значения прижаты вправо
   (`justifyContent="space-between"`), цвета из живой темы хоста. Секция встаёт в слот
   `sidebar_content` с порядком 150 — сразу после внутреннего блока 100, остальные
   секции не двигаются.
3. Состояния: `ready` (есть данные), `empty` (нет ответов модели — «No usage yet.»),
   `unavailable` (свёртка не удалась целиком). Нули без данных не показываются.

## Установка

Симлинк файла в директорию плагинов и запись в `tui.json` — нужны оба шага (сканер
TUI-плагинов читает список из `tui.json`, проверено в 039 и повторено здесь):

```bash
ln -sfn "$PWD/src/usage-panel.tsx" ~/.config/opencode/plugins/token-usage.tsx
```

Глобальный `~/.config/opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "/home/<you>/.config/opencode/plugins/token-usage.tsx"
  ]
}
```

`node_modules` пакета содержит только devDependencies (типы, solid-js для тестов,
typescript). Хост резолвит `solid-js` / `@opentui/*` в свои бандл-модули — второй
инстанс рендерера не создаётся; проверено живым TUI 1.18.21 при установленном
`node_modules`.

## Проверка

```bash
npm test        # юнит-тесты Usage Model через фейковый TuiPluginApi (solid-корень)
npm run typecheck
opencode        # открыть TUI в любом проекте, начать сессию
# ctrl+p → plugins → supercode.token-usage — active;
# после ответа модели в сайдбаре между Context и MCP появляется ▾ Token Usage
```

Фикстуры (`src/fixtures/history.json`) — реальные сессии из локальной истории
OpenCode, обрезанные до нужных полей, с один раз посчитанными ожидаемыми итогами
(`expected`); синтезированных сообщений в наборе нет. Краевые формы, которых история
не содержит (несколько `step-finish` у одного сообщения — рантайм схлопывает их),
собираются в тесте из реальных payload'ов и помечены комментарием.

## Границы тикета 01

Полная свёртка один раз при открытии сессии. Инкрементальное накопление — тикет 02,
скоростные строки — 03, расход сабагентов (`Session Family`) — 04.
