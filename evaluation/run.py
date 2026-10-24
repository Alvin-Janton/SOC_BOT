"""Sequential, evaluator-only CLI. Import/help/preflight never load AWS credentials."""

import argparse
from pathlib import Path
import re
import subprocess
import sys
import time
from urllib.parse import urlsplit
import uuid

from scripts.chat_client import DEFAULT_API_URL, endpoint_argument, message_argument, terminal_text
from . import VERSION, api, evidence, judge, report
from .common import EvaluationError, diagnostic, digest, encoded, integer, now, object_json, require, text, utc

ROOT = Path(__file__).resolve().parents[1]
TABLES = {"app": "application_events", "waf": "waf_events", "vpc": "vpc_flow_events", "cloudtrail": "cloudtrail_events"}


def parser() -> argparse.ArgumentParser:
    """Expose explicit dev configuration, not arbitrary conversation replay or repeats."""
    cli = argparse.ArgumentParser(description="Run the private SOC Bot dev investigation baseline (paid API + judge calls).")
    cli.add_argument('--cases', type=Path, default=Path('evaluation/cases.json'))
    cli.add_argument('--case-ids', nargs='+', help='Known case IDs; selection retains file order.')
    cli.add_argument('--api-url', type=endpoint_argument, default=DEFAULT_API_URL)
    cli.add_argument('--chat-table', required=True, help='Explicit dev base table: SOC-BOT-DEV-CHAT-HISTORY')
    cli.add_argument('--region', default='us-east-1')
    cli.add_argument('--profile', help='Existing evaluator SDK profile (not deployment credentials).')
    cli.add_argument('--judge-model', default=judge.DEFAULT_MODEL)
    cli.add_argument('--output-dir', type=Path, default=Path('artifacts/evaluation'))
    return cli


def identifier(value: object) -> bool:
    """Restrict local reference identifiers to printable, stable tokens."""
    return isinstance(value, str) and bool(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', value))


def validate_cases(document: dict) -> list[dict]:
    """Validate reviewed case/rubric identities, UTC scopes and internal references."""

    require(set(document) == {'schema_version', 'cases'} and type(document['schema_version']) is int
            and document['schema_version'] == 1 and isinstance(document['cases'], list)
            and 1 <= len(document['cases']) <= 32, 'Invalid version-1 cases document.')

    seen = set()

    for case in document['cases']:
        require(isinstance(case, dict) and set(case) == {'case_id', 'question', 'scope', 'expected_findings', 'acceptable_evidence',
                'required_outcome_distinctions', 'acceptable_playbook_sections', 'expected_guidance', 'unsupported_conclusions', 'scoring_notes'}, 'Invalid case fields.')

        require(identifier(case['case_id']) and case['case_id'] not in seen, 'Invalid/duplicate case ID.')
        seen.add(case['case_id'])
        require(isinstance(case['question'], str), 'Case question must be text.')
        message_argument(case['question'])
        scope = case['scope']

        require(isinstance(scope, dict) and scope.get('environment') == 'dev' and scope.get('database') == 'soc_bot_dev_security'
                and scope.get('source_type') in TABLES and scope.get('table') == TABLES[scope['source_type']], 'Only reviewed dev scopes are supported.')

        start, end = utc(scope.get('start_time')), utc(scope.get('end_time'))
        require(start < end and scope.get('start_inclusive') is True and type(scope.get('end_inclusive')) is bool, 'Invalid scope bounds.')
        expected_convention = '[start_time, end_time]' if scope['end_inclusive'] else '[start_time, end_time)'

        require(scope.get('boundary_convention') == expected_convention and integer(scope.get('expected_record_count'))
                and isinstance(scope.get('reference_counts'), dict) and text(scope.get('source_filename'), 256), 'Invalid scope metadata.')

        for field in ('expected_findings', 'acceptable_evidence', 'required_outcome_distinctions', 'acceptable_playbook_sections', 'expected_guidance', 'unsupported_conclusions'):
            require(isinstance(case[field], list) and len(case[field]) <= 128, 'Invalid bounded case array.')

        local_ids = set()

        for field, key in (('expected_findings', 'finding_id'), ('acceptable_evidence', 'evidence_id')):

            for item in case[field]:
                require(isinstance(item, dict) and identifier(item.get(key)) and item[key] not in local_ids, 'Invalid/duplicate finding or evidence ID.')
                local_ids.add(item[key])

                if field == 'acceptable_evidence':

                    event_time = utc(item.get('event_time'))
                    require(start <= event_time and (event_time <= end if scope['end_inclusive'] else event_time < end), 'Evidence lies outside the declared scope.')
                    require(integer(item.get('source_line'), 1) and text(item.get('source_filename'), 256)
                            and text(item.get('source_record_ref'), 256) and isinstance(item.get('native_indicators'), dict)
                            and isinstance(item.get('observed_outcome'), dict), 'Invalid evidence locator/fields.')

                else:
                    require(text(item.get('description'), 8192) and text(item.get('category'), 1024)
                            and text(item.get('observed_outcome'), 8192), 'Invalid finding description.')

        evidence_ids = {item['evidence_id'] for item in case['acceptable_evidence']}

        for item in case['expected_findings'] + case['required_outcome_distinctions']:
            require(isinstance(item, dict) and text(item.get('description'), 8192) and isinstance(item.get('evidence_ids'), list), 'Invalid finding/outcome evidence references.')
            refs = item['evidence_ids']
            require(all(isinstance(ref, str) and ref in evidence_ids for ref in refs) and len(set(refs)) == len(refs), 'Unknown/duplicate evidence reference.')

        sections = set()

        for section in case['acceptable_playbook_sections']:

            require(isinstance(section, dict) and set(section) == {'document_id', 'section_id'}
                    and identifier(section['document_id']) and identifier(section['section_id']), 'Invalid playbook reference.')

            pair = (section['document_id'], section['section_id'])
            require(pair not in sections, 'Duplicate playbook reference.')
            sections.add(pair)

        for guidance in case['expected_guidance']:

            require(isinstance(guidance, dict) and text(guidance.get('description'), 8192)
                    and isinstance(guidance.get('playbook_sections'), list), 'Invalid guidance reference.')

            linked = []

            for section in guidance['playbook_sections']:

                require(isinstance(section, dict) and set(section) == {'document_id', 'section_id'}, 'Invalid guidance section.')
                pair = (section['document_id'], section['section_id'])
                require(pair in sections and pair not in linked, 'Unknown/duplicate guidance section.')
                linked.append(pair)

        require(all(text(item, 8192) for item in case['unsupported_conclusions']), 'Invalid unsupported-conclusion text.')
        notes = case['scoring_notes']

        require(isinstance(notes, dict) and text(notes.get('grading_policy'), 8192)
                and isinstance(notes.get('criteria'), dict) and set(notes['criteria']) == set(judge.CRITERIA), 'Invalid scoring criteria.')

        for key, criterion in notes['criteria'].items():

            require(isinstance(criterion, dict), 'Invalid rubric criterion.')

            if key == 'retrieved_and_applied_guidance' and not case['expected_findings']:
                require(criterion.get('applicability') == 'not_applicable', 'Benign guidance must remain N/A, not automatic points.')

            if criterion.get('applicability') == 'not_applicable':
                require(set(criterion) == {'applicability', 'reason'} and key == 'retrieved_and_applied_guidance'
                        and not case['expected_findings'] and text(criterion['reason'], 8192), 'Invalid N/A rubric.')

            else:
                require(set(criterion) == {'applicability', 'anchors'} and criterion['applicability'] == 'applicable'
                        and isinstance(criterion['anchors'], dict) and set(criterion['anchors']) == {'0', '1', '2'}
                        and all(text(anchor, 8192) for anchor in criterion['anchors'].values()), 'Missing 0/1/2 rubric anchors.')

    return document['cases']


def preflight(args) -> tuple[list[dict], bytes, str]:
    """Reject invalid local inputs/configuration before SDK imports or any network call."""

    require(sys.version_info >= (3, 11), 'Python 3.11+ is required.')
    args.cases = args.cases.resolve(strict=True)
    require(args.cases.is_file() and args.cases.stat().st_size <= 1048576, 'Cases must be a file at most 1 MiB.')
    raw = args.cases.read_bytes()
    cases = validate_cases(object_json(raw))

    if args.case_ids:
        require(len(set(args.case_ids)) == len(args.case_ids) and set(args.case_ids) <= {case['case_id'] for case in cases}, 'Unknown or duplicate selected case IDs.')
        cases = [case for case in cases if case['case_id'] in args.case_ids]

    endpoint_argument(args.api_url)
    url = urlsplit(args.api_url)
    require(url.path == '/dev/chat' and not url.query, 'This initial evaluator accepts only a full /dev/chat endpoint without query parameters.')
    require(args.chat_table == 'SOC-BOT-DEV-CHAT-HISTORY', 'This initial evaluator accepts only SOC-BOT-DEV-CHAT-HISTORY.')
    require(bool(re.fullmatch(r'[a-z]{2}(?:-[a-z]+)+-\d', args.region)), 'Invalid AWS Region.')
    require(text(args.judge_model, 2048) and bool(re.fullmatch(r'[A-Za-z0-9:/_.-]+', args.judge_model)), 'Invalid judge model identifier.')

    # Managed-prompt ARNs replace the Converse controls and are not supported here.
    require(':prompt/' not in args.judge_model, 'Managed prompt ARNs are not supported as judge models.')
    require(args.profile is None or text(args.profile, 128) and not any(ord(char) < 32 for char in args.profile), 'Invalid profile name.')
    args.output_dir = args.output_dir.resolve()
    require(args.output_dir != args.cases and (not args.output_dir.exists() or args.output_dir.is_dir()), 'Output root must be a directory, not an input file.')

    if args.output_dir.is_relative_to(ROOT):
        require(args.output_dir.is_relative_to(ROOT / 'artifacts'), 'In-repository reports must stay under the ignored artifacts/ tree.')

    prompt_path = Path(__file__).with_name('judge_prompt.txt')
    require(prompt_path.stat().st_size <= 16384, 'Judge prompt exceeds its local cap.')
    prompt = prompt_path.read_text(encoding='utf-8')
    require(prompt.startswith(judge.PROMPT_VERSION + '\n'), 'Judge prompt version mismatch.')
    return cases, raw, prompt


def revision() -> dict:
    """Read local Git identity without configuration changes or requiring Git."""

    try:

        result = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=ROOT, capture_output=True, text=True, timeout=3, check=True)
        commit = result.stdout.strip()
        require(bool(re.fullmatch(r'[a-fA-F0-9]{40,64}', commit)), 'Unexpected Git revision.')
        return {'local_commit': commit, 'limitation': 'Local revision only; uncommitted files and deployed revision are not established by this SHA.'}

    except (OSError, subprocess.SubprocessError, EvaluationError):
        return {'local_commit': None, 'limitation': 'Local Git revision unavailable; deployed revision is not established.'}


def make_run(args, cases: list[dict], raw: bytes, prompt: str) -> dict:
    """Snapshot all question/reference data and fresh turn IDs before dispatch."""

    timestamp = now()

    return {'schema_version': report.RESULT_SCHEMA_VERSION, 'status': 'ready', 'errors': [],
            'metadata': {'run_id': str(uuid.uuid4()), 'started_at': timestamp, 'finished_at': None, 'evaluator_version': VERSION,
                         'judge_prompt_version': judge.PROMPT_VERSION, 'judge_prompt_sha256': digest(prompt.encode('utf-8')),
                         'judge_prompt': prompt, 'cases_sha256': digest(raw), 'cases_path': str(args.cases),
                         'selected_case_ids': [case['case_id'] for case in cases], 'revision': revision(),
                         'configuration': {'environment': 'dev', 'api_url': args.api_url, 'chat_table': args.chat_table,
                                           'region': args.region, 'profile_name': args.profile, 'judge_model': args.judge_model},
                         'judge_settings': judge.settings(args.judge_model),
                         'model_override_note': 'Unrecognized model controls are omitted, never guessed. No thinking is requested; non-text/reasoning responses are rejected.',
                         'limits': {'api': api.LIMITS, 'evidence': evidence.LIMITS, 'judge': judge.LIMITS, 'artifact_bytes': report.ARTIFACT_BYTES}},
            'cases': [{'case_id': case['case_id'], 'status': 'not_run', 'reference_key': case,
                       'application': api.initial(str(uuid.uuid4())), 'evidence': {'status': 'not_run'},
                       'judge': {'status': 'not_run'}, 'execution_checks': None, 'total': None} for case in cases]}


def evaluate_case(session, args, case: dict, prompt: str, checkpoint) -> None:
    """Execute one fresh request, audit evidence, then judge only a verified completion."""

    case['status'] = 'running'
    case['application']['status'] = 'incomplete'
    checkpoint()
    api.collect(args.api_url, case['reference_key']['question'], case['application'])
    checkpoint()

    if not case['application']['conversation_id']:
        case['status'] = 'incomplete'
        case['evidence'] = {'status': 'incomplete', 'error': {'code': 'NO_CONVERSATION_ID', 'message': 'No returned conversation identity; no evidence read or grading.'}}
        return

    stage = case['evidence']
    stage.update(status='incomplete', statistics={}, started_at=now())
    checkpoint()
    started = time.monotonic()

    try:
        records = evidence.read_events(session, args.chat_table, case['application']['conversation_id'], stage['statistics'])
        stage['data'] = evidence.select(records, case['reference_key'], case['application'])
        stage['status'] = stage['data']['status']
        case['execution_checks'] = evidence.execution_checks(case['reference_key'], case['application'], stage['data'])

    except KeyboardInterrupt:
        stage['error'] = {'code': 'INTERRUPTED', 'message': 'Evidence read interrupted; no score.'}
        raise

    except Exception as exc:
        stage.update(status='error', error=diagnostic(exc))
        case['status'] = 'error'

    finally:
        stage['wall_seconds'] = round(time.monotonic() - started, 6)
        stage['finished_at'] = now()
    checkpoint()

    if (case['application']['terminal'] or {}).get('truncated') is True:
        case['status'] = 'incomplete'
        case['judge']['skip_reason'] = 'APPLICATION_TRUNCATED'
        return

    if stage['status'] != 'completed':
        if case['status'] != 'error':
            case['status'] = 'incomplete'
        return

    stage = case['judge']
    started = time.monotonic()
    stage.update(status='incomplete', usage=None, started_at=now())

    try:
        data = judge.bundle(case['reference_key'], case['application'], case['evidence']['data'], case['execution_checks'])
        stage['input'] = data
        stage['input_sha256'] = digest(encoded(data))
        stage['projection_version'] = judge.PROJECTION_VERSION
        payload = judge.request(args.judge_model, prompt, data)
        stage['request_sha256'] = digest(encoded(payload))
        stage['request_bytes'] = len(encoded(payload))
        checkpoint()
        judgment = judge.grade(session, payload, data, stage)
        stage.update(status='completed', judgment=judgment)
        case['total'] = judge.total(judgment)
        case['status'] = 'scored'

    except report.ArtifactWriteError:
        # A failed pre-judge checkpoint is local persistence failure, not a judge response/error.
        raise

    except KeyboardInterrupt:
        stage['error'] = {'code': 'INTERRUPTED', 'message': 'Judge interrupted; remote completion/billing may be unknown.'}
        raise

    except Exception as exc:
        stage.update(status='incomplete' if isinstance(exc, EvaluationError) and exc.code == 'JUDGE_INPUT_LIMIT' else 'error', error=diagnostic(exc))
        case['status'] = 'incomplete' if stage['status'] == 'incomplete' else 'error'

    finally:
        stage['wall_seconds'] = round(time.monotonic() - started, 6)
        stage['finished_at'] = now()


def progress(message: str) -> None:
    """Print concise, single-line, control-character-safe operator progress."""
    print(terminal_text(message).replace('\n', ' ').replace('\r', ' ').replace('\t', ' '), flush=True)


def main(argv: list[str] | None = None) -> int:
    """Validate offline first; preserve major-stage artifacts and explicit exit semantics."""

    cli = parser()
    args = cli.parse_args(argv)

    try:
        cases, raw, prompt = preflight(args)

    except (EvaluationError, OSError, ValueError, TypeError, KeyError, argparse.ArgumentTypeError) as exc:
        cli.error(diagnostic(exc)['message'])

    run = make_run(args, cases, raw, prompt)
    directory = args.output_dir / (run['metadata']['started_at'].replace(':', '').replace('.', '') + '-' + run['metadata']['run_id'])
    current = None
    artifact_failed = False
    owns_directory = False

    def checkpoint():
        """Propagate safe typed diagnostics and halt before any subsequent paid stage can begin."""

        nonlocal artifact_failed
        try:
            report.save(directory, run)

        except report.ArtifactWriteError:
            artifact_failed = True
            raise

        except Exception as exc:
            artifact_failed = True
            raise report.ArtifactWriteError('save', 'not_selected', exc) from exc

    def note_artifact_failure(error: report.ArtifactWriteError, phase: str) -> None:
        """Keep primary/final errors in order and print only the writer's content-free projection."""
        nonlocal artifact_failed
        artifact_failed = True
        info = error.diagnostic()
        run['errors'].append(info)
        progress('Artifact failure (' + phase + '): ' + encoded(info).decode('utf-8'))

    exit_code = 1

    try:
        try:
            args.output_dir.mkdir(parents=True, exist_ok=True)
            directory.mkdir(exist_ok=False)
        except OSError as exc:
            raise report.ArtifactWriteError('directory_create', 'not_selected', exc) from exc
        owns_directory = True
        checkpoint()

        # Lazy import: help/configuration checks never resolve credentials or need boto3.
        import boto3
        session = boto3.Session(profile_name=args.profile, region_name=args.region)
        run['status'] = 'running'

        for current in run['cases']:
            progress(f"{current['case_id']}: starting one fresh request")
            evaluate_case(session, args, current, prompt, checkpoint)

            if artifact_failed:
                raise EvaluationError('ARTIFACT_WRITE', 'Artifact failure halted the run; no additional cases dispatched.')

            checkpoint()
            progress(f"{current['case_id']}: {current['status']}")
        run['status'] = 'completed' if all(case['status'] == 'scored' for case in run['cases']) else 'incomplete'
        exit_code = 0 if run['status'] == 'completed' else 1

    except KeyboardInterrupt as exc:
        exit_code = 130
        run['status'] = 'interrupted'

        if current and current['status'] != 'scored':
            current['status'] = 'interrupted'

        if isinstance(exc.__cause__, report.ArtifactWriteError):
            note_artifact_failure(exc.__cause__, 'interrupted_cleanup')
        run['errors'].append({'code': 'INTERRUPTED', 'message': 'Stopped locally. Closing connections does not cancel remote work; do not assume an unconfirmed attempt was free.'})

    except Exception as exc:
        run['status'] = 'error'
        if isinstance(exc, report.ArtifactWriteError):
            note_artifact_failure(exc, 'checkpoint')
        else:
            run['errors'].append(diagnostic(exc))
            progress('Evaluation stopped: ' + diagnostic(exc)['message'])

    finally:
        run['metadata']['finished_at'] = now()
        final_saved = False

        try:
            if owns_directory:
                report.save(directory, run)
                final_saved = True

            else:
                artifact_failed = True

        except KeyboardInterrupt as exc:
            exit_code = 130
            run['status'] = 'interrupted'
            artifact_failed = True
            if isinstance(exc.__cause__, report.ArtifactWriteError):
                note_artifact_failure(exc.__cause__, 'final_interrupted_cleanup')
            run['errors'].append({'code': 'INTERRUPTED', 'message': 'Final local artifact save interrupted; the prior snapshot may be the latest.'})
            progress('Final local artifact save interrupted; snapshot persistence is not confirmed.')

        except Exception as exc:
            if run['status'] != 'interrupted':
                run['status'] = 'error'
            error = exc if isinstance(exc, report.ArtifactWriteError) else report.ArtifactWriteError('save', 'not_selected', exc)
            note_artifact_failure(error, 'final_save')

        if artifact_failed:
            if final_saved:
                progress('Final diagnostic snapshot saved, but the earlier artifact failure still halts this run; evaluation was not resumed.')
            else:
                progress('Artifact persistence is not confirmed; saved statuses may predate this failure. results.json is authoritative and report.html may be stale. Inspect safe terminal diagnostics.')
            if exit_code != 130:
                exit_code = 1

        else:
            progress(f"Saved {directory / 'results.json'} and report.html")

    return exit_code


if __name__ == '__main__':
    raise SystemExit(main())
