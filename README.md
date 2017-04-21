# http-replay
Firefox extension for HTTP recording and re-playing. This is Add-on SDK based extension.
While recording it listens all HTTP queries and saves requests and responses into files.
Then using re-play command we can load saved data into browser cache so browser shows the same result page as it showed while recording.

Use [jpm](https://developer.mozilla.org/en-US/Add-ons/SDK/Tools/jpm) to manage Add-on SDK extension:
* `jpm xpi` builds xpi
* `jpm run` launches clean instance of Firefox with this add-on installed
