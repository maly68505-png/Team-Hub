import zipfile

import pytest

from autocut import models


@pytest.fixture(autouse=True)
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("AUTOCUT_HOME", str(tmp_path / "home"))


def fake_model():
    d = models.local_pipeline()
    (d / "segmentation").mkdir(parents=True)
    (d / "config.yaml").write_text("pipeline: {}\n")
    (d / "segmentation" / "pytorch_model.bin").write_bytes(b"\0" * 1000)


def test_export_then_import_on_another_machine(tmp_path, monkeypatch):
    fake_model()
    assert models.ready()
    z = models.export_zip(tmp_path)
    assert z.name == "autocut-models.zip"
    monkeypatch.setenv("AUTOCUT_HOME", str(tmp_path / "colleague"))
    assert not models.ready()
    models.import_zip(z)
    assert models.ready()
    assert (models.local_pipeline() / "segmentation" / "pytorch_model.bin").stat().st_size == 1000
    src, local = models.resolve("community-1")
    assert local and src == str(models.local_pipeline())


def test_import_rejects_foreign_or_unsafe_zips(tmp_path):
    bad = tmp_path / "bad.zip"
    with zipfile.ZipFile(bad, "w") as z:
        z.writestr("something/else.txt", "x")
    with pytest.raises(models.ModelError, match="not an Autocut model"):
        models.import_zip(bad)
    evil = tmp_path / "evil.zip"
    with zipfile.ZipFile(evil, "w") as z:
        z.writestr(f"{models.MODEL_NAME}/config.yaml", "x")
        z.writestr(f"{models.MODEL_NAME}/../../escape.txt", "x")
    with pytest.raises(models.ModelError, match="unsafe"):
        models.import_zip(evil)
    assert not (tmp_path / "escape.txt").exists()


def test_resolve():
    with pytest.raises(models.ModelError):
        models.resolve("community-1")
    assert models.resolve("someone/other-model") == ("someone/other-model", False)
