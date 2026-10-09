import { test } from "node:test";
import assert from "node:assert/strict";
import { videoLink, videoLinks } from "../src/video-links.ts";
import { humanSize } from "../src/media-format.ts";
test("GTK video paths and metadata share one canonical video identity", () => {
  const id = "M7lc1UVf-VE",
    expected = "https://www.youtube.com/watch?v=" + id;
  for (const url of [
    "https://youtu.be/" + id,
    "https://m.youtube.com/watch?v=" + id + "&t=2",
    "https://www.youtube.com/shorts/" + id,
    "https://youtube.com/embed/" + id,
    "https://youtube.com/live/" + id,
    "https://youtube.com/v/" + id,
  ])
    assert.equal(videoLink(url)?.url, expected);
  assert.equal(
    videoLink("https://dai.ly/x9abcde")?.url,
    "https://www.dailymotion.com/video/x9abcde",
  );
  assert.equal(
    videoLink("https://www.dailymotion.com/video/x9abcde_a-title")?.id,
    "x9abcde",
  );
  assert.equal(
    videoLink("https://vimeo.com/12345678")?.embed,
    "https://player.vimeo.com/video/12345678",
  );
});
test("video IDs cannot escape the embed path and lookalike hosts are plain links", () => {
  for (const url of [
    "javascript:alert(1)",
    "ftp://youtube.com/watch?v=M7lc1UVf-VE",
    "https://notyoutube.com/watch?v=M7lc1UVf-VE",
    "https://youtube.com.evil.test/watch?v=M7lc1UVf-VE",
    "https://user:secret@youtube.com/watch?v=M7lc1UVf-VE",
    "https://youtube.com/watch?v=../../../",
    "https://vimeo.com/%3Cscript%3E",
    "not a URL",
  ])
    assert.equal(videoLink(url), undefined);
});
test("bare text is detected without server markdown links, deduplicated and limited to three", () => {
  const links = videoLinks(
    "A https://youtu.be/M7lc1UVf-VE https://youtube.com/watch?v=M7lc1UVf-VE [clip](https://vimeo.com/123). https://dai.ly/x9ab https://vimeo.com/456",
  );
  assert.deepEqual(
    links.map((video) => video.provider),
    ["YouTube", "Vimeo", "Dailymotion"],
  );
});
test("file sizes use the native card units at byte and unit boundaries", () => {
  assert.equal(humanSize(0), "0 B");
  assert.equal(humanSize("1023"), "1023 B");
  assert.equal(humanSize(1024), "1.0 KB");
  assert.equal(humanSize(10 * 1024), "10 KB");
  assert.equal(humanSize(1024 ** 2), "1.0 MB");
});
