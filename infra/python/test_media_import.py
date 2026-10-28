import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from media_import import download


class DownloadBoundaryTests(unittest.TestCase):
    def exercise(self, info, received_bytes=1):
        operations = []

        class Downloader:
            def __init__(self, options):
                self.options = options

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                pass

            def extract_info(self, _url, download=False):
                operations.append(("metadata", download))
                return info

            def process_info(self, _info):
                operations.append(("download", True))
                for hook in self.options["progress_hooks"]:
                    hook({"downloaded_bytes": received_bytes})
                Path(self.options["outtmpl"]).write_bytes(b"explicit fixture")

        with tempfile.TemporaryDirectory(prefix="riffcut-python-test-") as directory:
            with patch.dict(sys.modules, {"yt_dlp": types.SimpleNamespace(YoutubeDL=Downloader)}):
                result = download("https://www.youtube.com/watch?v=4WjQ9AMhsPc", directory)
        return result, operations

    def test_combined_video_uses_one_download(self):
        result, operations = self.exercise({"id": "fixture", "title": "fixture", "duration": 1197, "extractor_key": "Youtube", "acodec": "aac"})
        self.assertEqual(result["audioFile"], "video.mp4")
        self.assertEqual(operations, [("metadata", False), ("download", True)])

    def test_rejects_unsupported_metadata(self):
        for extra in ({"duration": 1801}, {"is_live": True}, {"_type": "playlist"}, {"extractor_key": "Generic"}):
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                self.exercise({"id": "fixture", "title": "fixture", "duration": 60, "extractor_key": "Youtube", "acodec": "aac", **extra})

    def test_stops_unknown_length_downloads_at_byte_limit(self):
        with self.assertRaises(ValueError):
            self.exercise({"id": "fixture", "title": "fixture", "duration": 60, "extractor_key": "Youtube", "acodec": "aac"}, received_bytes=126 * 1024 * 1024)


if __name__ == "__main__":
    unittest.main()
