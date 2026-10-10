param(
    [Parameter(Mandatory)][string]$BinaryPath,
    [string]$ArtifactRoot = (Join-Path ([IO.Path]::GetTempPath()) ('mna-verify-' + [Guid]::NewGuid().ToString('N'))),
    [string]$CatalogOutput
)
$ErrorActionPreference = 'Stop'
$binary = (Resolve-Path -LiteralPath $BinaryPath).Path
$ArtifactRoot = [IO.Path]::GetFullPath($ArtifactRoot)
New-Item -ItemType Directory -Force -Path $ArtifactRoot | Out-Null
$importRoot = Join-Path $ArtifactRoot 'import'
$exportRoot = Join-Path $ArtifactRoot 'export'
New-Item -ItemType Directory -Force -Path $importRoot, $exportRoot | Out-Null
$utf8 = New-Object Text.UTF8Encoding($false)
$serviceKey = [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')
$analystKey = [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')
$headers = @{ Authorization = "Bearer $serviceKey" }
$analystHeaders = @{ Authorization = "Bearer $serviceKey"; 'X-MNA-Analyst-Key' = $analystKey }
$socket = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
$socket.Start()
$port = $socket.LocalEndpoint.Port
$socket.Stop()
$baseUrl = "http://127.0.0.1:$port"
$environment = @{
    MNA_API_KEY=$serviceKey; MNA_ANALYST_KEY=$analystKey; MNA_BIND="127.0.0.1:$port"
    MNA_DB_PATH=(Join-Path $ArtifactRoot 'test.db'); MNA_IMPORT_DIR=$importRoot
    MNA_EXPORT_DIR=$exportRoot; MNA_ARTIFACT_DIR=(Join-Path $ArtifactRoot 'web')
    MNA_ENABLE_EXTERNAL='false'; MNA_MEILI_URL=$null; MNA_MEILI_API_KEY=$null
}
$previous = @{}
$script:server = $null
function Assert-True([bool]$Condition, [string]$Message) {
    if (!$Condition) { throw "Verification failed: $Message" }
}
function Write-Fixture([string]$Name, [string]$Text) {
    [IO.File]::WriteAllText((Join-Path $importRoot $Name), $Text, $utf8)
}
function Post-Json([string]$Path, $Body, [bool]$Analyst = $false) {
    $requestHeaders = if ($Analyst) { $analystHeaders } else { $headers }
    Invoke-RestMethod -Method Post -Uri "$baseUrl$Path" -Headers $requestHeaders -ContentType 'application/json' -Body ($Body | ConvertTo-Json -Depth 60 -Compress)
}
function Expect-Status([string]$Path, $Body, [int]$Expected) {
    try { Post-Json $Path $Body | Out-Null }
    catch {
        if ($null -ne $_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq $Expected) { return }
        throw
    }
    throw "Expected HTTP $Expected at $Path"
}
function Start-TestServer([string]$Suffix) {
    $script:server = Start-Process -FilePath $binary -WorkingDirectory $ArtifactRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $ArtifactRoot "server-$Suffix.out.log") -RedirectStandardError (Join-Path $ArtifactRoot "server-$Suffix.err.log")
    for ($attempt = 0; $attempt -lt 100; $attempt++) {
        if ($script:server.HasExited) { throw "Test server exited; inspect server-$Suffix.err.log" }
        try { Invoke-RestMethod -Uri "$baseUrl/health" | Out-Null; return } catch { Start-Sleep -Milliseconds 100 }
    }
    throw 'Test server did not become ready'
}
function Stop-TestServer {
    if ($null -ne $script:server -and !$script:server.HasExited) {
        Stop-Process -Id $script:server.Id
        $script:server.WaitForExit()
    }
    $script:server = $null
}
try {
    foreach ($name in $environment.Keys) {
        $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        [Environment]::SetEnvironmentVariable($name, $environment[$name], 'Process')
    }
    Start-TestServer 'initial'
    $catalog = @((Invoke-RestMethod -Uri "$baseUrl/tools" -Headers $headers).tools)
    $adminCatalog = @((Invoke-RestMethod -Uri "$baseUrl/admin/tools" -Headers $analystHeaders).tools)
    Assert-True ($catalog.Count -eq 89 -and $adminCatalog.Count -eq 39) '89 agent and 39 privileged schemas'
    [IO.File]::WriteAllText((Join-Path $ArtifactRoot 'admin-tool-catalog.json'), ($adminCatalog | ConvertTo-Json -Depth 60), $utf8)
    if ($CatalogOutput) { [IO.File]::WriteAllText([IO.Path]::GetFullPath($CatalogOutput), ($catalog | ConvertTo-Json -Depth 60), $utf8) }
    Write-Fixture 'mid.csv' @'
ECID,CID,Company Name,Description,Website,HQ City,HQ State
E1,C1,PolicyNest,Insurance policy administration software,mid.example,Boston,MA
NA,C2,ClaimNest,Insurance claims workflow software,claims.example,Austin,TX
E3,,RiskNest,Insurance risk workflow software,risk.example,Denver,CO
NA,#N/A,Missing identity,Insurance software,missing.example,,
'@
    $imported = Post-Json '/admin/company-files' @{ files=@('mid.csv'); source='MID' } $true
    Assert-True ($imported.inserted -eq 3 -and $imported.quarantined -eq 1) 'ID variants and excluded missing identity'
    $runId = 'VERIFY-' + [Guid]::NewGuid().ToString('N')
    Post-Json '/admin/runs' @{ run_id=$runId; objective='Fictional insurance software verification'; original_criteria=@{ business='Insurance workflow software'; country='India'; revenue_min=1000000 }; initial_profile=@{ core_business_query='insurance workflow software'; core_business_criteria=@('Owned insurance workflow software'); unused_criteria=@(@{ criterion='India and revenue'; reason='Recorded, unused for discovery' }) } } $true | Out-Null
    $searchArgs = @{ run_id=$runId; query='insurance'; mode='lexical'; filters=@{ country=@('India'); revenue_min=100000000 }; limit=10; prefer_meilisearch=$false }
    Expect-Status '/tools/search_mid' $searchArgs 409
    Post-Json '/admin/profiles/approve' @{ run_id=$runId; version=1; approved_by='fictional verification analyst' } $true | Out-Null
    $search = Post-Json '/tools/search_mid' $searchArgs
    Assert-True ($search.total -eq 3 -and $search.ignored_search_filters.Count -eq 2) 'qualitative search reports ignored geography and financial filters'
    $companyIds = @($search.results | ForEach-Object { $_.company.company_id })
    Assert-True ($companyIds -contains 'E1-C1' -and $companyIds -contains 'X-C2' -and $companyIds -contains 'E3-X') 'derived and provisional IDs'
    Post-Json '/tools/add_candidates' @{ run_id=$runId; companies=$companyIds; discovery_source='MID'; query_id=$search.query_id } | Out-Null
    $summary = Post-Json '/tools/get_discovery_summary' @{ run_id=$runId }
    Assert-True ($summary.total_unique -eq 3 -and $summary.mid_only -eq 3 -and $summary.recommended_next_step -eq 'PITCHBOOK_ENRICHMENT') 'source summary and small-funnel recommendation'
    $label = @{ run_id=$runId; company_id='E1-C1'; label='BEST_FIT'; analyst_note='Fictional analyst feedback for verification' }
    Expect-Status '/tools/label_company' $label 403
    Post-Json '/tools/call' @{ tool='label_company'; arguments=$label } $true | Out-Null
    Write-Fixture 'mapping.csv' @'
pk,PBId,Firm Name from PitchBook,Website from PitchBook,Company Profile,Investor Profile,Limited Partner Profile,Service Provider Profile
E1-C1,PB1,PolicyNest PB,pb.example,Yes,No,No,No
X-C2,PB2,ClaimNest,claims.example,No,No,No,No
'@
    Write-Fixture 'pb.csv' @'
PitchBook export
Company ID,Companies,Website,Description,LinkedIn URL,HQ Location,Active Investors,Universe,Wide field
PB1,PolicyNest PB,pb.example,Insurance policy software,https://www.linkedin.com/company/policynest/,Boston,Example investor,Companies,Retained in Parquet
© PitchBook Data, Inc. 2027
'@
    Write-Fixture 'rogo.csv' @'
Research export
Website,Product ownership
pb.example,Owned product reported
mid.example,Old website must not join
'@
    $enriched = Post-Json '/tools/import_enrichment_files' @{ run_id=$runId; files=@('rogo.csv','pb.csv','mapping.csv') }
    Assert-True ($enriched.pbid_populated -eq 1 -and $enriched.pb_unique_companies -eq 1 -and $enriched.rogo_unique_companies -eq 1 -and $enriched.rogo_unmatched -eq 1) 'mixed file order and strict PB website join'
    Assert-True (Test-Path -LiteralPath $enriched.parquet_files[0]) 'real Parquet artifact exists'
    $company = Post-Json '/tools/get_company' @{ company_id='PBID:PB1' }
    Assert-True ($company.company_id -eq 'E1-C1' -and $company.PB_Name -eq 'PolicyNest PB' -and $company.ROGO.'Product ownership' -eq 'Owned product reported') 'cross-reference and compact enrichment hydration'
    $prepared = Post-Json '/tools/propose_prepared_plan' @{ run_id=$runId; mode='screening'; provider='llm_suite'; deployment='offline-fixture'; prompt='Score core business only'; output_columns=@('Fit Score','Rationale'); score_columns=@('Fit Score'); batch_size=2 }
    Assert-True ($prepared.schema_version -eq 2 -and !$prepared.executed -and $prepared.snapshot.rows.Count -eq 3 -and $prepared.snapshot.compiled_prompt.Contains('CHECK')) 'full v2 prepared scope and visible compiled prompt'
    $pbRow = @($prepared.snapshot.rows | Where-Object { $_.pk -eq 'E1-C1' })[0]
    Assert-True ($pbRow.'Company Name' -eq 'PolicyNest PB' -and $pbRow.Website -eq 'pb.example' -and $pbRow.Description.Contains('MID') -and $pbRow.Description.Contains('PitchBook')) 'source-aware PB preference and labeled description'
    $approval = @{ plan_id=$prepared.plan_id; digest=$prepared.digest; approved_by='fictional verification analyst'; approval_key='fixture-v2-approval' }
    Expect-Status '/admin/prepared-plan-approve' $approval 403
    Post-Json '/admin/prepared-plan-approve' $approval $true | Out-Null
    $approvedPlan = Post-Json '/tools/get_prepared_plan' @{ plan_id=$prepared.plan_id }
    Assert-True ($approvedPlan.status -eq 'APPROVED' -and !$approvedPlan.executed -and $approvedPlan.jobs.Count -eq 2) 'atomic approval creates two durable unexecuted jobs'
    $secondJob = Post-Json '/tools/get_execution_job' @{ job_id=$approvedPlan.jobs[1].job_id }
    Assert-True (!$secondJob.executed -and $secondJob.payload.indices.Count -eq 1 -and $secondJob.payload.indices[0] -eq 3) 'global index remains three in second batch'
    Expect-Status '/admin/execution-lease' @{ job_id=$approvedPlan.jobs[0].job_id; controller_id='fixture' } 403
    $textRequest = @{ request_id='fixture-command'; run_id=$runId; allowed_tools=@('get_company'); attempt=0; response="BEGIN TOOL v1 get_company`ncompany_id:text = `"E1-C1`"`nEND TOOL" }
    $command = Post-Json '/agent/commands' $textRequest
    Assert-True ($command.ok -and $command.result.company_id -eq 'E1-C1') 'typed text tool command executes after validation'
    $exports = @()
    foreach ($kind in @('PITCHBOOK','LLM','FULL')) {
        $export = Post-Json '/tools/export_candidate_set' @{ run_id=$runId; export_type=$kind; file_name="$kind.xlsx" }
        Assert-True ((Test-Path -LiteralPath $export.path) -and $export.companies -eq 3) "$kind workbook"
        $exports += $export.path
    }
    Expect-Status '/tools/export_candidate_set' @{ run_id=$runId; export_type='FULL'; file_name='FULL.xlsx' } 409
    $plan = Post-Json '/tools/propose_action_plan' @{ run_id=$runId; rationale='Fictional analyst asked for screening'; steps=@(@{ step_id='fit'; kind='llm_screening'; company_ids=@('E1-C1','X-C2') }) }
    Post-Json '/admin/actions/approve' @{ run_id=$runId; plan_id=$plan.plan_id; approved_by='fictional verification analyst'; approve=$true } $true | Out-Null
    $batch = Post-Json '/tools/prepare_screening_batch' @{ run_id=$runId; plan_id=$plan.plan_id; step_id='fit'; engine='llm_suite'; company_ids=@('E1-C1','X-C2'); prompt='Assess core business only; score 0 to 10 or CHECK with rationale'; output_columns=@('fit_score','rationale','product_ownership') }
    Assert-True (!$batch.executed -and $batch.companies.Count -eq 2) 'hydrated external handoff without inference'
    $saved = Post-Json '/tools/save_screening_results' @{ run_id=$runId; plan_id=$plan.plan_id; step_id='fit'; batch_id=$batch.batch_id; results=@(@{ company_id='E1-C1'; fit_score=8.5; rationale='Fictional returned score'; additional_columns=@{ product_ownership='reported' } }, @{ company_id='X-C2'; fit_score='CHECK'; rationale='Need product evidence' }) }
    Post-Json '/tools/complete_action_step' @{ run_id=$runId; plan_id=$plan.plan_id; step_id='fit'; receipt_ids=@($saved.operation_receipt_id) } | Out-Null
    Post-Json '/tools/save_checkpoint' @{ run_id=$runId; namespace='verification'; expected_sequence=0; state=@{ phase='finished'; plan_id=$plan.plan_id; batch_id=$batch.batch_id } } | Out-Null
    Stop-TestServer
    Start-TestServer 'restart'
    $checkpoint = Post-Json '/tools/get_checkpoint' @{ run_id=$runId; namespace='verification' }
    $scores = @(Post-Json '/tools/get_screening_results' @{ run_id=$runId; company_id='E1-C1' })
    Assert-True ($checkpoint.state.phase -eq 'finished' -and $scores.Count -eq 1 -and $scores[0].result.fit_score -eq 8.5) 'checkpoint and screening survive restart'
    $recoveredPlan = Post-Json '/tools/get_prepared_plan' @{ plan_id=$prepared.plan_id }
    Assert-True ($recoveredPlan.digest -eq $prepared.digest -and $recoveredPlan.status -eq 'APPROVED' -and $recoveredPlan.jobs.Count -eq 2) 'v2 approval and jobs survive executable restart'
    $proof = @{ passed=$true; run_id=$runId; tools=$catalog.Count; administrator_operations=$adminCatalog.Count; unique_companies=$summary.total_unique; exports=$exports; pb_unique_companies=$enriched.pb_unique_companies; rogo_unique_companies=$enriched.rogo_unique_companies; restart_recovery=$true; prepared_v2_recovery=$true; text_command_validated=$true; external_providers_called=$false }
    [IO.File]::WriteAllText((Join-Path $ArtifactRoot 'proof.json'), ($proof | ConvertTo-Json -Depth 10), $utf8)
    $proof | ConvertTo-Json -Depth 10
}
finally {
    Stop-TestServer
    foreach ($name in $previous.Keys) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
}
