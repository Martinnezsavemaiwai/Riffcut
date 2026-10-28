import copy
import unittest

from render_preview import validate_manifest, make_timeline, ass_text, validate_phrases, phrase_timeline, styled_ass, sound_bed


class PreviewTests(unittest.TestCase):
    def setUp(self):
        self.pack = {"durationMs": 60000, "transcriptSegments": [
            {"id": "evidence-1", "startMs": 10000, "endMs": 20000, "text": "นักเรียนเข้าทดสอบพลัง"}
        ]}
        self.manifest = {"title": "วันทดสอบ", "reviewed": True, "rightsConfirmed": True, "segments": [
            {"text": "นักเรียนต้องทดสอบพลัง", "captions": ["นักเรียนต้องทดสอบพลัง"],
             "sourceStartMs": 11000, "sourceEndMs": 19000,
             "evidence": [{"segmentId": "evidence-1", "quote": "เข้าทดสอบพลัง"}]}
        ]}

    def test_rejects_unreviewed_fabricated_or_outside_source_edits(self):
        validate_manifest(self.manifest, self.pack)
        for key, value in [("reviewed", False), ("rightsConfirmed", False)]:
            changed = copy.deepcopy(self.manifest)
            changed[key] = value
            with self.assertRaises(ValueError):
                validate_manifest(changed, self.pack)
        for key, value in [("sourceEndMs", 61000), ("sourceStartMs", -1),
                           ("evidence", [{"segmentId": "evidence-1", "quote": "invented"}]),
                           ("captions", ["different narration"])]:
            changed = copy.deepcopy(self.manifest)
            changed["segments"][0][key] = value
            with self.assertRaises(ValueError):
                validate_manifest(changed, self.pack)

    def test_measures_pcm_samples_and_rejects_footage_shorter_than_voice(self):
        timeline = make_timeline(self.manifest, [(32000, 16000)])
        self.assertEqual(timeline[0]["endMs"], 2250)
        with self.assertRaises(ValueError):
            make_timeline(self.manifest, [(160000, 16000)])

    def test_styled_mode_requires_phrase_synthesis(self):
        with self.assertRaises(ValueError):
            validate_manifest(self.manifest, self.pack, styled=True)

    def test_phrase_timing_uses_audio_samples_and_explicit_pauses(self):
        segment = {"text": "ทดสอบ พลัง", "phrases": [
            {"text": "ทดสอบ", "pauseMs": 180},
            {"text": "พลัง", "pauseMs": 320}
        ]}
        validate_phrases(segment)
        result = phrase_timeline(segment["phrases"], [(16000, 16000), (32000, 16000)])
        self.assertEqual(result, [
            {"text": "ทดสอบ", "startMs": 0, "speechEndMs": 1000, "endMs": 1180},
            {"text": "พลัง", "startMs": 1180, "speechEndMs": 3180, "endMs": 3500}
        ])
        changed = copy.deepcopy(segment)
        changed["phrases"][0]["text"] = "invented"
        with self.assertRaises(ValueError):
            validate_phrases(changed)
        changed = copy.deepcopy(segment)
        changed["phrases"][0]["pauseMs"] = 3000
        with self.assertRaises(ValueError):
            validate_phrases(changed)

    def test_styled_caption_uses_phrase_audio_boundaries_and_safe_highlights(self):
        manifest = {"title": "ทดสอบ", "segments": [{"keywords": ["พลัง"]}]}
        timeline = [{"startMs": 0, "endMs": 3500}]
        phrases = [[{"text": "ทดสอบพลัง", "startMs": 0, "speechEndMs": 1000, "endMs": 1180},
                    {"text": "{ไม่ใช่คำสั่ง}", "startMs": 1180, "speechEndMs": 3180, "endMs": 3500}]]
        result = styled_ass(manifest, timeline, phrases, "local voice")
        self.assertIn("Kanit", result)
        self.assertIn("0:00:01.18", result)
        self.assertIn("\\1c&H55DCFF&", result)
        self.assertNotIn("{ไม่ใช่คำสั่ง}", result)

    def test_soundtrack_is_finite_bounded_and_fades_at_the_edges(self):
        import numpy as np
        audio = sound_bed(2, [0.5], rate=16000)
        self.assertEqual(audio.shape, (32000, 2))
        self.assertTrue(np.isfinite(audio).all())
        self.assertLessEqual(float(np.max(np.abs(audio))), 0.22)
        self.assertGreater(float(np.sqrt(np.mean(audio * audio))), 0.015)
        self.assertEqual(float(audio[0, 0]), 0)

    def test_captions_use_measured_timing_and_escape_ass_commands(self):
        self.manifest["segments"][0]["captions"] = ["{bad}\\N", "สอง"]
        timeline = make_timeline(self.manifest, [(32000, 16000)])
        rendered = ass_text(self.manifest, timeline)
        self.assertIn("0:00:02.25", rendered)
        self.assertNotIn("{bad}", rendered)
        self.assertNotIn("\\N\\N", rendered)


if __name__ == "__main__":
    unittest.main()
