#Requires -Version 7.0

<#
.SYNOPSIS
    Pester tests for the W365Swap PowerShell module.
.DESCRIPTION
    Unit tests with mocked Graph API calls. Compatible with Pester v3.
    Does NOT require a real tenant.
#>

$modulePath = Join-Path $PSScriptRoot '..' 'src' 'W365Swap.psd1'
Import-Module $modulePath -Force

Describe 'Module Loading' {
    It 'Should import the module without errors' {
        $module = Get-Module -Name 'W365Swap'
        $module | Should Not BeNullOrEmpty
        $module.Name | Should Be 'W365Swap'
    }

    It 'Should export expected functions' {
        $expectedFunctions = @(
            'Connect-W365Swap'
            'Get-W365CloudPC'
            'New-W365Snapshot'
            'Export-W365Environment'
            'Import-W365Environment'
            'Restore-W365Environment'
            'Get-W365SwapStatus'
        )

        $exportedFunctions = (Get-Module 'W365Swap').ExportedFunctions.Keys
        foreach ($fn in $expectedFunctions) {
            ($exportedFunctions -contains $fn) | Should Be $true
        }
    }

    It 'Should export exactly 7 functions' {
        $exportedFunctions = (Get-Module 'W365Swap').ExportedFunctions.Keys
        $exportedFunctions.Count | Should Be 7
    }
}

Describe 'State Manager' {
    $script:testStatePath = Join-Path $env:TEMP "w365swap-test-$(Get-Random).json"

    BeforeEach {
        if (Test-Path $script:testStatePath) { Remove-Item $script:testStatePath -Force }
        # Pester v3 InModuleScope doesn't support -ArgumentList/-Parameters
        # so we call Initialize-StateFile by setting the variable in module scope first
        & (Get-Module 'W365Swap') { param($p) Initialize-StateFile -Path $p } $script:testStatePath
    }

    It 'Should create a valid state file' {
        Test-Path $script:testStatePath | Should Be $true
        $state = Get-Content $script:testStatePath -Raw | ConvertFrom-Json
        $state.version | Should Be '1.0'
    }

    It 'Should add an operation record' {
        InModuleScope 'W365Swap' {
            Add-OperationRecord -OperationId 'op-1' -Type 'snapshot' `
                -CloudPcId 'test-cpc-1' -ProjectName 'test'
            $state = Get-SwapState
            $op = $state.operations | Where-Object { $_.operationId -eq 'op-1' }
            $op | Should Not BeNullOrEmpty
            $op.type | Should Be 'snapshot'
            $op.status | Should Be 'inProgress'
        }
    }

    It 'Should update operation status' {
        InModuleScope 'W365Swap' {
            Add-OperationRecord -OperationId 'op-2' -Type 'export' `
                -CloudPcId 'test-cpc-1' -ProjectName 'test'
            Update-OperationStatus -OperationId 'op-2' -Status 'completed'
            $state = Get-SwapState
            $op = $state.operations | Where-Object { $_.operationId -eq 'op-2' }
            $op.status | Should Be 'completed'
            $op.completedAt | Should Not BeNullOrEmpty
        }
    }

    It 'Should cap operations to the 100 most recent' {
        InModuleScope 'W365Swap' {
            for ($i = 1; $i -le 105; $i++) {
                Add-OperationRecord -OperationId "op-$i" -Type 'snapshot' `
                    -CloudPcId 'test-cpc-1' -ProjectName 'test'
            }
            $state = Get-SwapState
            @($state.operations).Count | Should Be 100
        }
    }

    AfterEach {
        if (Test-Path $script:testStatePath) { Remove-Item $script:testStatePath -Force -ErrorAction SilentlyContinue }
    }
}

Describe 'Graph API Helper' {
    It 'Should fail when not authenticated' {
        InModuleScope 'W365Swap' {
            Clear-GraphSession
        }
        $threw = $false
        try { InModuleScope 'W365Swap' { Invoke-GraphRequest -Uri '/test' } } catch { $threw = $true }
        $threw | Should Be $true
    }
}

# Cleanup
Remove-Module 'W365Swap' -Force -ErrorAction SilentlyContinue