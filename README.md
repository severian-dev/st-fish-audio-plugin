# Fish Audio plugin for SillyTavern

Server plugin for the [Fish Audio TTS](https://github.com/severian-dev/st-fish-audio) extension. Fish's speech API
does not accept calls from a browser, so this plugin makes them from the SillyTavern server. It holds your API key and
streams audio back.

No dependencies, no build step. Node 18 or newer.

## Install

In your SillyTavern folder:

```
node plugins.js install https://github.com/severian-dev/st-fish-audio-plugin
```

Set `enableServerPlugins: true` in `config.yaml`, then restart SillyTavern. The console should print
`[fish-audio] loaded`.

Then install the extension and save your key from its settings panel. See the
[extension's README](https://github.com/severian-dev/st-fish-audio).

## Routes

All under `/api/plugins/fish-audio`, behind SillyTavern's login.

| Route | Does |
| --- | --- |
| `GET /status` | Plugin version, whether a key is saved, allowed models. |
| `GET /voices` | Searches Fish voices. `title`, `language`, `tag`, `sort_by`, `page_size`, `page_number`, `self=true` for your own. |
| `GET /voices/:id` | One voice. |
| `GET /credit` | Your Fish API credit. |
| `POST /tts` | Starts synthesis. Answers with a job id once Fish accepts the request. |
| `GET /tts/:id` | Streams the job's MP3. |
| `POST /design` | Designs voices from a description (Fish Voice Design, $0.01 each). Answers with candidates to audition. |
| `GET /design/:id/:index` | Plays a candidate (WAV). |
| `POST /design/:id/:index/save` | Saves a candidate as a private voice on the user's Fish account. |
| `GET /cache` | Cached clips and bytes for this user. |
| `DELETE /cache` | Clears this user's cache. |

## Notes

- Each user's key is read from their own SillyTavern secrets (`api_key_fish_audio`). It is never sent to the browser.
- Requests are checked before they reach Fish: a fixed model list, known fields only, ranges enforced. Fish bills a
  missing or unknown model as its paid S2.1 Pro, so nothing else gets through.
- At most 5 Fish requests run at once per key. Busy answers (429) are retried with backoff.
- Audio jobs belong to the user who started them and stay in memory for 30 minutes after they finish.
- An expired job answers with a short silence, so SillyTavern's TTS queue keeps moving.
- Designed candidates stay in memory for 30 minutes, so the audio never travels back up from the browser. Saving sends
  Fish the candidate's signature, which marks the new voice as designed.
- Generated audio is cached per user in `data/_cache/fish-audio`, up to 200 MB each, least recently used first. A repeat
  request is served from disk. Identical requests still generating share one Fish call. Send `cache: false` to skip it.

## License

MIT
